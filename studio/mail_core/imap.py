# Copyright (C) 2026 Adecubed
# SPDX-License-Identifier: AGPL-3.0-or-later
# Derived from Gigamail d65ba498cfa6cca2c5871500369f2c1b80a52814.
# Modified by Paiton on 2026-09-10; see NOTICE and LICENSE in this directory.
"""Reused MIME decoding and IMAP helpers, adapted for bounded read-only sync."""
import email.header
import imaplib
import ssl
from typing import Optional, List

def _safe_decode(data: bytes, charset: str = "utf-8") -> str:
    """
    Decodifica bytes provando charset dichiarato -> utf-8 -> latin-1.
    Gestisce charset non standard (es. 'unknown-8bit') che fanno esplodere
    .decode() con LookupError prima ancora di errors='replace'.
    """
    if not isinstance(data, bytes):
        return str(data or "")
    for enc in (charset or "utf-8", "utf-8", "latin-1"):
        try:
            return data.decode(enc, errors="replace")
        except (LookupError, ValueError):
            continue
    return data.decode("latin-1", errors="replace")

def _hdr_str(value) -> str:
    """Coerce un valore header a str: msg.get() puo' restituire
    email.header.Header per header malformati/non-ASCII grezzi."""
    if isinstance(value, str):
        return value
    if value is None:
        return ""
    try:
        return str(value)
    except Exception:
        return ""

def _decode_header(value) -> str:
    parts = email.header.decode_header(_hdr_str(value))
    decoded = []
    for part, charset in parts:
        if isinstance(part, bytes):
            decoded.append(_safe_decode(part, charset))
        else:
            decoded.append(str(part))
    return " ".join(decoded)

def _get_body(msg):
    html_body = ""
    plain_body = ""
    if msg.is_multipart():
        for index, part in enumerate(msg.walk()):
            if index >= 100:
                break
            ct = part.get_content_type()
            cd = str(part.get("Content-Disposition", ""))
            if "attachment" in cd.lower() or part.get_filename():
                continue
            if ct == "text/html" and not html_body:
                payload = part.get_payload(decode=True)
                if payload:
                    charset = part.get_content_charset() or "utf-8"
                    html_body = _safe_decode(payload, charset).strip()
            elif ct == "text/plain" and not plain_body:
                payload = part.get_payload(decode=True)
                if payload:
                    charset = part.get_content_charset() or "utf-8"
                    plain_body = _safe_decode(payload, charset).strip()
    else:
        payload = msg.get_payload(decode=True)
        charset = msg.get_content_charset() or "utf-8"
        raw = _safe_decode(payload, charset).strip() if payload else ""
        if msg.get_content_type() == "text/html":
            html_body = raw
        else:
            plain_body = raw
    if plain_body:
        return plain_body, "text"
    return html_body, "html"

def _close_conn_safely(conn: Optional[imaplib.IMAP4_SSL]) -> None:
    if not conn:
        return
    try:
        conn.logout()
    except Exception:
        try:
            conn.shutdown()
        except Exception:
            pass

def _uid_search(conn: imaplib.IMAP4_SSL, *criteria: str) -> List[bytes]:
    for charset in ("UTF-8", None):
        try:
            typ, data = conn.uid("search", charset, *criteria)
            if typ == "OK":
                return (data[0] or b"").split() if data else []
        except imaplib.IMAP4.error:
            continue
    raise ConnectionError("The inbox could not be searched.")


def _uid_recent_ids(conn: imaplib.IMAP4_SSL, top: int) -> List[bytes]:
    """
    Prova a ottenere direttamente gli UID più recenti con SORT.
    Fallback a SEARCH ALL se il server non supporta SORT.
    """
    try:
        typ, data = conn.uid("SORT", "(REVERSE DATE)", "UTF-8", "ALL")
        if typ == "OK" and data and data[0]:
            ordered = data[0].split()
            return ordered[:top]
    except Exception:
        pass

    ids = _uid_search(conn, "ALL")
    if not ids:
        return []
    return ids[-top:][::-1]


def _connect(imap_host, imap_port, email_addr, password, timeout=15):
    """Paiton modification: verified TLS, per-socket timeout, no global changes."""
    conn = imaplib.IMAP4_SSL(imap_host, imap_port,
                            ssl_context=ssl.create_default_context(), timeout=timeout)
    try:
        conn.login(email_addr, password)
    except Exception:
        _close_conn_safely(conn)
        raise
    return conn
