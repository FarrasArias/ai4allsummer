# backend/utilities/web_tools.py
"""
Web search and page reading for the Web tab, without any API key.

Search goes through the ddgs library (DuckDuckGo and other public engines).
It's unofficial: engines may briefly throttle bursts of searches. The
inference queue already runs web prompts one at a time, which helps.

Pages are fetched by this Mac directly. That makes the server a fetcher for
anyone online, so it must never be pointed inward: a request to
http://localhost:8000 would arrive from loopback on the owner's port and be
served as the owner (utilities/access.py). Every address — the first one,
each redirect, and the one actually connected to (which defeats DNS
rebinding) — has to be a public internet address.
"""

from __future__ import annotations

import ipaddress
import socket
from html.parser import HTMLParser
from typing import Any, Dict, List, Optional
from urllib.parse import urljoin, urlsplit

import httpx

MAX_RESULTS = 10
MAX_PAGE_BYTES = 2_000_000
MAX_REDIRECTS = 5
TIMEOUT_SECONDS = 15
MAX_LINKS = 30
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"


class WebToolError(RuntimeError):
    """Shown to the model as the tool's result, so it can tell the user."""


# -- search ----------------------------------------------------------------------

def search(query: str, max_results: int = 5) -> Dict[str, Any]:
    from ddgs import DDGS
    from ddgs.exceptions import DDGSException, RatelimitException, TimeoutException

    try:
        n = max(1, min(int(max_results or 5), MAX_RESULTS))
    except (TypeError, ValueError):
        n = 5
    try:
        hits = DDGS(timeout=TIMEOUT_SECONDS).text(query, max_results=n)
    except RatelimitException:
        raise WebToolError("Web search is being rate-limited right now. Try again in a minute.")
    except TimeoutException:
        raise WebToolError("Web search timed out. Try again.")
    except DDGSException as e:
        # ddgs raises this for "no results" as well as failures
        if "no results" in str(e).lower():
            return {"results": []}
        raise WebToolError(f"Web search failed: {e}")
    return {
        "results": [
            {"title": h.get("title", ""), "url": h.get("href", ""), "content": h.get("body", "")}
            for h in hits or []
        ]
    }


# -- page reading ----------------------------------------------------------------------

def _is_public(ip: str) -> bool:
    addr = ipaddress.ip_address(ip.split("%", 1)[0])
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped:
        addr = addr.ipv4_mapped
    return addr.is_global and not addr.is_multicast


def _check_url(url: str) -> None:
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise WebToolError("Only http and https pages can be read.")
    if not parts.hostname or parts.username or parts.password:
        raise WebToolError("That isn't a page address that can be read.")
    try:
        port = parts.port or (443 if parts.scheme == "https" else 80)
        infos = socket.getaddrinfo(parts.hostname, port, type=socket.SOCK_STREAM)
    except (socket.gaierror, ValueError):
        raise WebToolError(f"Couldn't find the site {parts.hostname}.")
    if not infos or not all(_is_public(info[4][0]) for info in infos):
        raise WebToolError("That address isn't on the public internet, so it can't be read.")


def fetch(url: str) -> Dict[str, Any]:
    """Read a public web page: its title, text and links."""
    with httpx.Client(
        follow_redirects=False,  # each hop is checked below
        timeout=TIMEOUT_SECONDS,
        trust_env=False,         # a proxy would hide which address is really reached
        headers={"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9"},
    ) as client:
        for _ in range(MAX_REDIRECTS + 1):
            _check_url(url)
            with client.stream("GET", url) as resp:
                stream = resp.extensions.get("network_stream")
                peer = stream.get_extra_info("server_addr") if stream else None
                if not peer or not _is_public(peer[0]):
                    raise WebToolError("That address isn't on the public internet, so it can't be read.")
                if resp.is_redirect and resp.headers.get("location"):
                    url = urljoin(url, resp.headers["location"])
                    continue
                if resp.status_code >= 400:
                    raise WebToolError(f"The page answered with an error ({resp.status_code}).")
                ctype = resp.headers.get("content-type", "").split(";")[0].strip().lower()
                if ctype and ctype not in ("text/html", "application/xhtml+xml", "text/plain"):
                    raise WebToolError(f"That link isn't a web page ({ctype}).")
                body = b""
                for chunk in resp.iter_bytes():
                    body += chunk
                    if len(body) >= MAX_PAGE_BYTES:
                        break
                text = body[:MAX_PAGE_BYTES].decode(resp.encoding or "utf-8", errors="replace")
                final_url = str(resp.url)
            if ctype == "text/plain":
                return {"title": final_url, "url": final_url, "content": text, "links": []}
            return _page(text, final_url)
    raise WebToolError("Too many redirects.")


_SKIP = {"script", "style", "noscript", "svg", "template", "iframe", "head", "nav", "footer"}
_BLOCK = {"p", "div", "br", "li", "ul", "ol", "tr", "table", "section", "article", "header",
          "main", "aside", "blockquote", "pre", "h1", "h2", "h3", "h4", "h5", "h6", "dt", "dd", "hr"}


class _Extractor(HTMLParser):
    def __init__(self, base: str) -> None:
        super().__init__(convert_charrefs=True)
        self.base = base
        self.skip = 0
        self.in_title = False
        self.title = ""
        self.parts: List[str] = []
        self.links: List[str] = []

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag == "title":
            self.in_title = True
        if tag in _SKIP:
            self.skip += 1
        elif tag in _BLOCK:
            self.parts.append("\n")
        if tag == "a" and len(self.links) < MAX_LINKS:
            href = dict(attrs).get("href")
            if href:
                link = urljoin(self.base, href)
                if link.startswith(("http://", "https://")) and link not in self.links:
                    self.links.append(link)

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self.in_title = False
        if tag in _SKIP and self.skip:
            self.skip -= 1
        elif tag in _BLOCK:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self.in_title:
            self.title += data
        elif not self.skip:
            self.parts.append(data)


def _page(html: str, url: str) -> Dict[str, Any]:
    ex = _Extractor(url)
    try:
        ex.feed(html)
    except Exception:
        pass  # keep whatever was extracted from a malformed page
    lines = (" ".join(line.split()) for line in "".join(ex.parts).splitlines())
    content = "\n".join(line for line in lines if line)
    return {"title": " ".join(ex.title.split()) or url, "url": url, "content": content, "links": ex.links}
