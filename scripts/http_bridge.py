"""Talk only to an owned container's internal loopback, via docker exec stdin."""
import json
import sys
import urllib.request
request=json.load(sys.stdin)
data=json.dumps(request['body']).encode() if 'body' in request else None
response=urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:'+str(request['port'])+request['path'],data=data,headers={'Content-Type':'application/json'}),timeout=request.get('timeout',5))
sys.stdout.buffer.write(response.read())
