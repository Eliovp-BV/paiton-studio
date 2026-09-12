# Copyright (C) 2026 Adecubed
# SPDX-License-Identifier: AGPL-3.0-or-later
# Derived from Gigamail d65ba498cfa6cca2c5871500369f2c1b80a52814.
# Modified by Paiton on 2026-09-10; see NOTICE and LICENSE in this directory.
# GigaMail — mail for your AI agent
# Copyright (C) 2026 Adecubed
# Licensed under the GNU AGPL v3 or later. See LICENSE.
"""Consenso umano che un processo non puo' fornire.

Perche' esiste (r/mcp, agosto 2026)
-----------------------------------
L'approvazione fuori banda (console o CLI) basta contro un'istruzione
iniettata in una mail, ma non contro l'agente che il gate dovrebbe
supervisionare, se quell'agente ha una shell: `gigamail approvals approve
<id>` e' a una chiamata di tool dal gate. "Fuori banda rispetto a MCP" non
e' "fuori banda rispetto all'agente" finche' approvare e' un comando.

Questo modulo rende l'approvazione qualcosa che un processo puo' INVOCARE
ma non SODDISFARE: un prompt dell'OS sulla sessione fisica dell'utente.
Il processo lo apre e resta in attesa; solo l'umano lo chiude. Niente
codice da digitare, niente file da leggere, niente schermo da catturare.

Backend
-------
  Windows  UserConsentVerifier (Windows Hello: PIN/impronta/volto), WinRT.
           Misurato dal vivo il 2026-08-19 su Windows 11: il prompt scatta
           A OGNI chiamata, nessuna cache stile sudo (seconda richiesta
           immediata dopo una VERIFIED → nuovo prompt, 24 s di attesa
           umana). Si apre anche da un processo senza finestra.
  macOS    LocalAuthentication (Touch ID / password), reuse duration 0.
  Linux    nessun backend affidabile senza desktop → NON disponibile.

Regola: se nessun backend puo' chiedere a un umano, require_human() dice
NO. Mai fail-open. Il chiamante (CLI, console) deve rifiutare l'azione e
indicare la console, non degradare a una conferma da tastiera.

Paiton removes environment-variable approval overrides, including dry-run allow.
"""
import sys
from typing import Optional

_WIN = sys.platform == "win32"
_MAC = sys.platform == "darwin"


class ConsentUnavailable(RuntimeError):
    """Nessun backend in grado di chiedere a un umano su questa macchina."""


# ------------------------------------------------------------------ Windows

def _run_winrt(op):
    """Attende un IAsyncOperation WinRT da codice sincrono.
    asyncio.run vuole una coroutine (su 3.10 rifiuta l'operazione nuda):
    la avvolgiamo. Funziona anche se un event loop e' gia' attivo nel
    thread (console FastAPI): in quel caso usiamo un thread dedicato."""
    import asyncio
    import threading

    async def _await():
        return await op

    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(_await())
    box = {}

    def _runner():
        box["r"] = asyncio.run(_await())

    t = threading.Thread(target=_runner, daemon=True)
    t.start()
    t.join()
    return box.get("r")


def _win_available() -> bool:
    try:
        from winrt.windows.security.credentials.ui import (  # type: ignore
            UserConsentVerifier,
        )
        from winrt.windows.security.credentials.ui import (
            UserConsentVerifierAvailability as A,
        )
    except ImportError:
        return False
    try:
        r = _run_winrt(UserConsentVerifier.check_availability_async())
        return int(r) == int(A.AVAILABLE)
    except Exception:
        return False


# Perche' Windows ha detto di no. Tutti restano un NO — la sicurezza
# non cambia — ma "hai annullato" e "su questo PC Hello non e'
# configurato" richiedono due azioni diverse, e appiattirli sulla
# stessa frase lascia l'utente a indovinare quale dei due sia.
_MOTIVI_WIN = {
    0: "verificato",
    1: "su questo PC non e' configurato nessun metodo Hello (PIN, "
       "impronta o volto)",
    2: "Windows Hello non e' disponibile su questo dispositivo",
    3: "dispositivo occupato: un'altra verifica e' gia' in corso",
    4: "tentativi esauriti",
    5: "annullata",
}

_ultimo_motivo = ""


def last_reason() -> str:
    """Perche' l'ultima richiesta di conferma e' stata respinta.
    Vuoto se l'ultima e' andata a buon fine o non ce n'e' stata."""
    return _ultimo_motivo


def _win_ask(reason: str) -> bool:
    global _ultimo_motivo
    from winrt.windows.security.credentials.ui import (
        UserConsentVerificationResult as R,
    )
    from winrt.windows.security.credentials.ui import (  # type: ignore
        UserConsentVerifier,
    )
    # Il messaggio e' mostrato dentro il dialogo di Windows Hello.
    r = _run_winrt(UserConsentVerifier.request_verification_async(reason))
    ok = int(r) == int(R.VERIFIED)
    _ultimo_motivo = "" if ok else _MOTIVI_WIN.get(
        int(r), f"esito {int(r)} non riconosciuto")
    return ok


# -------------------------------------------------------------------- macOS

def _mac_available() -> bool:
    try:
        import LocalAuthentication  # type: ignore  # pyobjc-framework-LocalAuthentication
    except ImportError:
        return False
    ctx = LocalAuthentication.LAContext.alloc().init()
    ok, _err = ctx.canEvaluatePolicy_error_(
        LocalAuthentication.LAPolicyDeviceOwnerAuthentication, None)
    return bool(ok)


def _mac_ask(reason: str) -> bool:
    import threading

    import LocalAuthentication  # type: ignore
    ctx = LocalAuthentication.LAContext.alloc().init()
    # Nessun riuso della verifica precedente: ogni approvazione e' una
    # verifica. (Default 0, ma lo fissiamo: e' la proprieta' che conta.)
    ctx.setTouchIDAuthenticationAllowableReuseDuration_(0)
    done = threading.Event()
    result = {"ok": False}

    def _reply(success, error):
        result["ok"] = bool(success)
        done.set()

    ctx.evaluatePolicy_localizedReason_reply_(
        LocalAuthentication.LAPolicyDeviceOwnerAuthentication, reason, _reply)
    done.wait()
    return result["ok"]


# ----------------------------------------------------------------- registry

def backend_name() -> Optional[str]:
    """Nome del backend che verrebbe usato, o None se nessuno e' disponibile."""
    if _WIN and _win_available():
        return "windows-hello"
    if _MAC and _mac_available():
        return "macos-local-authentication"
    return None


def available() -> bool:
    return backend_name() is not None


def require_human(reason: str) -> bool:
    """Chiede all'utente fisico della macchina di confermare `reason`.

    Ritorna True SOLO se l'umano ha verificato la propria identita' in
    questo istante, per questa richiesta. Ritorna False se ha annullato,
    se la verifica e' fallita, o per qualunque altro esito.
    Solleva ConsentUnavailable se nessun backend puo' chiedere: il
    chiamante deve trattarlo come un NO e indicare la console.
    """
    global _ultimo_motivo
    _ultimo_motivo = ""
    if _WIN and _win_available():
        return _win_ask(reason)
    if _MAC and _mac_available():
        return _mac_ask(reason)
    raise ConsentUnavailable(
        "Protected send approval is unavailable on this host. Download the draft "
        "and review it in your mail application. Windows Hello or macOS "
        "LocalAuthentication is required for direct delivery."
    )
