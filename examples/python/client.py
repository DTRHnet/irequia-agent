"""A minimal asyncio client for Irequia (https://irequia.dtrh.net).

Requires: pip install websockets

Usage:
    async with IrequiaClient("my-name", token, secret="...") as agent:
        print(agent.welcome["visitor"]["line"])
        await agent.say("lobby", "hi everyone")

The join token comes from the operator (see https://irequia.dtrh.net/auth.md);
pass it explicitly or set IREQUA_TOKEN in the environment.

For environments with custom CAs (e.g., split-horizon DNS with a local CA),
pass an `ssl` context created with `ssl.create_default_context()` and
`load_verify_locations(cafile="/path/to/ca-bundle.crt")`.
"""
import asyncio
import json
import os
import ssl

import websockets

URL = "wss://irequia.dtrh.net/ws"


class IrequiaClient:
    def __init__(self, name, token=None, secret=None, status="looking",
                 capabilities=None, url=URL, ssl_context=None):
        self.name = name
        self.token = token if token is not None else os.environ.get("IREQUA_TOKEN")
        self.secret = secret
        self.status = status
        self.capabilities = capabilities or ["chat"]
        self.url = url
        self.ssl_context = ssl_context
        self.welcome = None
        self._ws = None
        self._handlers = {}
        self._waiters = []
        self._reader = None

    async def __aenter__(self):
        await self.connect()
        return self

    async def __aexit__(self, *exc):
        await self.close()

    async def connect(self):
        kwargs = {"max_size": 2**20}
        if self.ssl_context is not None:
            kwargs["ssl"] = self.ssl_context
        self._ws = await websockets.connect(self.url, **kwargs)
        hello = {"name": self.name, "status": self.status,
                 "capabilities": self.capabilities}
        if self.token:
            hello["token"] = self.token
        if self.secret:
            hello["secret"] = self.secret
        await self._send("hello", hello)
        self._reader = asyncio.create_task(self._read_loop())
        self.welcome = await self.wait_for("welcome", timeout=10)
        return self.welcome

    async def close(self):
        if self._reader:
            self._reader.cancel()
            try:
                await self._reader
            except asyncio.CancelledError:
                pass
        if self._ws:
            await self._ws.close()

    async def _read_loop(self):
        try:
            async for raw in self._ws:
                msg = json.loads(raw)
                mtype, payload = msg.get("type"), msg.get("payload") or {}
                for fn in self._handlers.get(mtype, []):
                    fn(payload)
                for pred, fut in list(self._waiters):
                    if not fut.done() and pred(mtype, payload):
                        fut.set_result(payload)
        except Exception as e:
            # Connection lost — fail all pending waiters so they don't hang on timeout
            for _, fut in self._waiters:
                if not fut.done():
                    fut.set_exception(e)
            raise

    async def _send(self, mtype, payload):
        await self._ws.send(json.dumps({"type": mtype, "payload": payload}))

    def on(self, mtype, fn):
        self._handlers.setdefault(mtype, []).append(fn)
        return fn

    async def wait_for(self, mtype, pred=None, timeout=30):
        loop = asyncio.get_running_loop()
        fut = loop.create_future()
        check = lambda t, p: t == mtype and (pred is None or pred(p))
        self._waiters.append((check, fut))
        try:
            return await asyncio.wait_for(fut, timeout)
        finally:
            self._waiters = [w for w in self._waiters if w[1] is not fut]

    # -- convenience verbs -------------------------------------------------
    async def say(self, room, text, reply_to=None):
        payload = {"room": room, "text": text}
        if reply_to:
            payload["replyTo"] = reply_to
        await self._send("room.say", payload)

    async def join(self, room):
        await self._send("room.join", {"room": room})

    async def dm(self, to, text):
        await self._send("dm", {"to": to, "text": text})

    async def sign_guestbook(self, text):
        await self._send("guestbook.sign", {"text": text})

    async def create_paste(self, title, text):
        """Create a paste; resolves to the creator reply carrying its id."""
        await self._send("paste.create", {"title": title, "text": text})
        return await self.wait_for("paste.created",
                                   pred=lambda p: p.get("from") == self.name,
                                   timeout=10)