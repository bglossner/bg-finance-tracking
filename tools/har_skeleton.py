#!/usr/bin/env python3
"""Produce a checked, structural JSON outline of a browser HAR."""

import argparse
import base64
from collections import Counter, defaultdict
from datetime import datetime
from email import policy
from email.message import Message
from email.parser import BytesParser
from email.utils import collapse_rfc2231_value
import html
from html.parser import HTMLParser
from ipaddress import IPv6Address
import json
import math
import os
from pathlib import Path
import re
import sys
import tempfile
from urllib.parse import parse_qsl, unquote, unquote_plus, urlsplit
from xml.parsers import expat


BANK_DOMAINS = ('chase.com', 'jpmorgan.com', 'jpmorganchase.com', 'jpmchase.com')
METHODS = frozenset('GET HEAD POST PUT DELETE CONNECT OPTIONS TRACE PATCH PROPFIND '
                    'PROPPATCH MKCOL COPY MOVE LOCK UNLOCK REPORT SEARCH'.split())
HTTP_TOKEN = re.compile(r"[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}")
NAME = re.compile(r'[A-Za-z_][A-Za-z0-9_.:\-\[\]]{0,127}')
HOST = re.compile(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?')
PATH = re.compile(r'(?:/(?:[A-Za-z]{1,11}|<id>|<token>)?)+')
MIME = re.compile(r'(?:application|audio|example|font|image|message|model|multipart|text|video)'
                  r'/[a-z0-9][a-z0-9.+-]{0,63}')
EXTENSION = re.compile(r'\.[a-z][a-z0-9]{0,5}\Z')
DISPOSITION = re.compile(r'(?:attachment|inline); filename=<name>(\.[a-z][a-z0-9]{0,5})')
FORM = 'application/x-www-form-urlencoded'
MULTIPART = 'multipart/form-data'
OFX_MIMES = frozenset('application/ofx application/qfx application/x-ofx application/x-qfx '
                      'application/vnd.intu.qfx application/vnd.intu.ofx text/ofx text/x-ofx'.split())
DOWNLOAD_MIMES = frozenset({'', 'application/octet-stream', 'text/plain', 'application/download',
                           'application/x-download', 'application/force-download',
                           'application/x-force-download', 'application/binary'})
HTML_MIMES = frozenset({'text/html', 'application/xhtml+xml'})
SCRIPT_MIMES = frozenset({'text/javascript', 'application/javascript', 'text/ecmascript',
                          'application/ecmascript', 'application/x-javascript'})
WEB_MIMES = HTML_MIMES | SCRIPT_MIMES | {'text/css'}
OFX_START = re.compile(rb'(?:OFXHEADER[ \t]*:|<OFX(?:[\s>]))', re.IGNORECASE)
SGML = re.compile(r'<!--(?P<comment>.*?)-->|<!\[CDATA\[(?P<cdata>.*?)\]\]>|'
                  r'<(?P<closing>/)?(?P<tag>[A-Za-z_][A-Za-z0-9_.:-]*)\s*>', re.DOTALL)

EMAIL = re.compile(r"[\w.!#$%&'*+/=?^`{|}~-]{1,64}@[\w-]+(?:\.[\w-]+)*")
DATE = re.compile(r'(?<!\d)(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|'
                  r'\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|'
                  r'(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01]))(?!\d)')
TEXT_DATE = re.compile(
    r'(?<![A-Za-z])(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|'
    r'jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)'
    r'[-_. /]+(?:0?[1-9]|[12][0-9]|3[01])(?:[,._ /-]+\d{2,4})?(?!\d)', re.I)
MONEY = re.compile(r'(?:\$|\bUSD)\s*[+-]?\s*(?:\d|[.,]\d)|'
                   r'(?<!\d)\d+(?:,\d{3})*\.\d{2}(?!\d)', re.I)
JWT = re.compile(r'eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}', re.I)
BLOB = re.compile(r'[A-Za-z0-9+/_-]{16,}={0,2}')
HEX_BLOB = re.compile(r'[a-fA-F0-9]{16,}')
CAMEL_BOUNDARY = re.compile(r'(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])')
SHORT_NAME_WORDS = frozenset('a an as at by for id if in no of on or to ui uk us'.split())
NAME_ACRONYMS = frozenset('ABA ACH API APR APY ATM BIC BIN CSP CSRF CSV CVV DNS HTML HTTP HTTPS IBAN ID IP '
                          'IRA ISO JSON JWT MFA MIME NFC OFX OTP PAN PCI PDF PIN QFX SAML SDK SSN SSO SWIFT TIN '
                          'TLS UI URI URL UTF UUID XML'.split())
LONG_OFX_TAGS = frozenset({'creditcardmsgsrqv1', 'creditcardmsgsrsv1'})
DIGITS = re.compile(r'\d{4,}')
UUID = re.compile(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', re.I)
HAR_TIME = re.compile(r'(?P<clock>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})'
                      r'(?:\.(?P<fraction>\d+))?(?P<offset>Z|[+-]\d{2}:?\d{2})')
FIXED_FIELDS = frozenset('''
    entries path_counts index relative_seconds duration_ms_bucket origin path method query
    request response headers cookie_count set_cookie_count content_type accept body status mime size_bucket
    disposition name type count fields first count_bucket
'''.split())
NUMERIC_LOCATIONS = re.compile(
    r'\$\.(?:entries\[\d+\]\.(?:index|relative_seconds|request\.cookie_count|'
    r'response\.(?:set_cookie_count|status))|path_counts\[\d+\]\.count)')
SIZE_BOUNDS = (128, 1024, 8192, 65536)
DURATION_BOUNDS = (10, 100, 1000, 10000)
COUNT_BOUNDS = (1, 5, 20, 100)
LENGTH_BOUNDS = (8, 32, 128)
TOKEN = re.compile(r'''[^\s"'=<>{}(),;]+''')
MIME_PARAMETER = re.compile(r';\s*((?:"(?:[^"\\]|\\.)*"|[^";])*)')
CDATA_TEXT = re.compile(r'<!\[CDATA\[(.*?)\]\]>', re.S)
WEB_LITERAL = re.compile(r'''(?P<comment>/\*.*?\*/|//[^\r\n]*)|'''
                         r'''(?P<quoted>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)''', re.S)
WEB_PROPERTY_END = re.compile(r'\s*:')
WEB_MIME_START = re.compile(r'''["'](?:content-type|accept)["']\s*:\s*\Z''', re.I)
JS_ROUTE_START = re.compile(r'(?<![\w$.])(?:(?:(?:window|self|globalThis)\.)?fetch|'
                            r'new\s+(?:(?:window|self|globalThis)\.)?Request)\s*\(\s*\Z')
CSS_ROUTE_START = re.compile(r'\burl\s*\(\s*\Z', re.I)
HTML_MIME_TAGS = frozenset('a embed link object script source style'.split())
HTML_ROUTE_ATTRIBUTES = {'href': frozenset('a area base image link use'.split()),
                         'src': frozenset('audio embed iframe img input script source track video'.split()),
                         'xlink:href': frozenset('a image use'.split())}
REQUEST_ORIGIN_HEADERS = frozenset({'origin', 'referer'})
RESPONSE_ORIGIN_HEADERS = frozenset({'access-control-allow-origin', 'location', 'timing-allow-origin'})


class InvalidInput(ValueError):
    pass


class InvalidArguments(ValueError):
    pass


class ArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        raise InvalidArguments


def scalars(value):
    if isinstance(value, dict):
        for child in value.values():
            yield from scalars(child)
    elif isinstance(value, list):
        for child in value:
            yield from scalars(child)
    elif isinstance(value, str) or type(value) in (int, float):
        yield str(value).strip().casefold()


def sensitive_scalars(value):
    return (text for text in scalars(value) if len(text) >= 8 or DIGITS.search(text))


class InputValues:
    """Track raw data and values extracted by the format-specific parsers."""

    def __init__(self, document):
        self.raw = Counter(sensitive_scalars(document))
        self.values = set()
        self.short_secrets = set()

    def remember(self, value):
        self.values.update(sensitive_scalars(value))

    def structural_occurrence(self, value):
        """Exclude one raw occurrence, preserving copies from other sources."""
        self.raw.subtract(sensitive_scalars(value))

    def remember_secret(self, value):
        if 0 < len(value) < 8:
            self.short_secrets.add(value.casefold())
        else:
            self.remember(value)

    def forbidden_prefixes(self):
        prefixes = defaultdict(list)
        values = self.values | {value for value, count in self.raw.items() if count > 0}
        for value in values:
            prefixes[value[:4]].append(value)
        return prefixes


def require(value, kind):
    if type(value) is not kind:
        raise InvalidInput
    return value


def unique_object(pairs):
    result = dict(pairs)
    if len(result) != len(pairs):
        raise InvalidInput
    return result


def invalid_constant(_value):
    raise InvalidInput


def finite_float(value):
    number = float(value)
    if not math.isfinite(number):
        raise InvalidInput
    return number


def parse_json(value):
    return json.loads(value, object_pairs_hook=unique_object,
                      parse_constant=invalid_constant, parse_float=finite_float)


def bucket(number, bounds):
    if number < 0:
        return 'unknown'
    if number == 0:
        return 'empty'
    for bound in bounds:
        if number <= bound:
            return f'le-{bound}'
    return f'gt-{bounds[-1]}'


def bucket_names(bounds):
    return frozenset(bucket(n, bounds) for n in (-1, 0, *bounds, bounds[-1] + 1))


SAFE_BUCKETS = {'size_bucket': bucket_names(SIZE_BOUNDS),
                'duration_ms_bucket': bucket_names(DURATION_BOUNDS),
                'count_bucket': bucket_names(COUNT_BOUNDS)}
VALUE_HINTS = frozenset({'<null>', '<bool>', '<num>', '<id>', '<int>', '<date>'}) | {
    f'<str:{name}>' for name in bucket_names(LENGTH_BOUNDS)
}
GENERATED_STRINGS = {
    **SAFE_BUCKETS,
    'body': VALUE_HINTS | {'<omitted>'},
    'type': VALUE_HINTS,
    'disposition': {'<omitted>', 'attachment', 'inline'},
    'mime': {'<omitted>'},
    'method': METHODS | {'<method>'},
    'origin': {'<third-party>'},
}


def has_email(value):
    return '@' in value and EMAIL.search(value) is not None


def value_hint(value):
    if value is None:
        return '<null>'
    if isinstance(value, bool):
        return '<bool>'
    if isinstance(value, float):
        return '<num>'
    if isinstance(value, int):
        return '<id>' if abs(value) >= 10**8 else '<int>'
    if value.lower() in ('true', 'false'):
        return '<bool>'
    if DATE.fullmatch(value) or TEXT_DATE.fullmatch(value) or re.fullmatch(DATE.pattern + r'[Tt].+', value):
        return '<date>'
    if re.fullmatch(r'[+-]?\d+', value):
        digits = value.lstrip('+-')
        return '<id>' if len(digits) >= 8 or (len(digits) >= 4 and digits.startswith('0')) else '<int>'
    if UUID.fullmatch(value) or has_email(value) or re.fullmatch(r'[A-Za-z0-9+/_-]{12,}={0,2}', value):
        return '<id>'
    return f'<str:{bucket(len(value), LENGTH_BOUNDS)}>'


def json_shape(value):
    if isinstance(value, dict):
        return {'fields': [{'name': key, 'type': json_shape(child)}
                           for key, child in sorted(value.items()) if not key.startswith('_')]}
    if isinstance(value, list):
        result = {'count_bucket': bucket(len(value), COUNT_BOUNDS)}
        if value:
            result['first'] = json_shape(value[0])
        return result
    return value_hint(value)


def mime_type(value):
    mime = value.partition(';')[0].strip().lower()
    return mime if MIME.fullmatch(mime) else ''


def accept_type(value):
    candidate = value.strip().lower()
    return candidate if MIME.fullmatch(candidate) or candidate == '*/*' else ''


def encoded_pairs(text, sources, *, from_post=False):
    if re.search(r'%(?![0-9a-fA-F]{2})', text):
        raise InvalidInput
    pairs = parse_qsl(text, keep_blank_values=True, errors='strict')
    for _, value in pairs:
        sources.remember(value)
    if '=' in text or '&' in text:
        sources.remember([text, unquote_plus(text, errors='strict')])
    elif from_post:
        # A bare form parameter contains only a name.
        sources.structural_occurrence(text)
    return pairs


def declared_pairs(items, sources):
    pairs = []
    for item in require(items, list):
        item = require(item, dict)
        name = require(item['name'], str)
        value = require(item.get('value', ''), str)
        sources.structural_occurrence(name)
        pairs.append((name, value))
    return pairs


def pair_shape(pairs):
    return [{'name': name, 'type': value_hint(value)}
            for name, value in sorted(pairs, key=lambda pair: pair[0])]


def bank_host(host):
    return (any(host == bank or host.endswith('.' + bank) for bank in BANK_DOMAINS)
            and all(HOST.fullmatch(label) for label in host.split('.')))


def bank_origin(value):
    scheme, _, host = value.strip().lower().partition('://')
    return scheme in ('http', 'https', 'ws', 'wss') and bank_host(host)


def url_shape(raw, include_host, sources):
    if re.search(r'[\x00-\x20\x7f]', raw):
        raise InvalidInput
    url = urlsplit(raw)
    if url.scheme not in ('http', 'https', 'ws', 'wss'):
        if url.scheme:
            return '<third-party>', '/<token>', [], '', ''
        raise InvalidInput
    host = (url.hostname or '').removesuffix('.')
    if ':' in host:
        if '%' in host:
            raise InvalidInput
        host = f'[{IPv6Address(host)}]'
    elif len(host) > 253 or not all(HOST.fullmatch(label) for label in host.split('.')):
        raise InvalidInput
    # Accessing port validates it even though the outline omits it.
    _ = url.port
    authority = f'{url.scheme}://{host}'
    allowed = bank_host(host) or (include_host and include_host.fullmatch(host))
    sources.structural_occurrence(raw)
    if not allowed:
        sources.remember(host)
    for value in (url.username, url.password):
        if value:
            sources.remember_secret(unquote(value, errors='strict'))
    if url.fragment:
        sources.remember(unquote(url.fragment, errors='strict'))
    path = []
    for segment in (url.path or '/').split('/'):
        if re.search(r'%(?![0-9a-fA-F]{2})', segment):
            raise InvalidInput
        decoded = unquote(segment, errors='strict')
        if not decoded or re.fullmatch(r'[A-Za-z]{1,11}', decoded):
            path.append(decoded)
        else:
            sources.remember([segment, decoded])
            is_id = re.search(r'\d{3,}', decoded) or UUID.fullmatch(decoded) or has_email(decoded)
            path.append('<id>' if is_id else '<token>')
    target = url.path or '/'
    if url.query:
        target += '?' + url.query
    return (authority if allowed else '<third-party>', '/'.join(path),
            encoded_pairs(url.query, sources), authority, target)


def remember_cookie(value, sources):
    name, sep, content = value.strip().partition('=')
    if not sep or not name.strip():
        return 0
    sources.remember_secret(name.strip())
    sources.remember_secret(content.strip().strip('"'))
    return 1


def mime_header(value, header, sources):
    if '\r' in value or '\n' in value:
        raise InvalidInput
    message = Message(policy=policy.compat32)
    message[header] = value
    for _, parameter in message.get_params(header=header, failobj=[])[1:]:
        sources.remember(collapse_rfc2231_value(parameter, errors='strict'))
    # The email parser cannot distinguish bare fragments from explicit empty values.
    for match in MIME_PARAMETER.finditer(value):
        fragment = match[1]
        if '=' not in fragment:
            remember_text(fragment, sources)
    return message


def header_shape(side, sources, *, response=False, authority='', target=''):
    names = set()
    values = defaultdict(list)
    origin_headers = RESPONSE_ORIGIN_HEADERS if response else REQUEST_ORIGIN_HEADERS
    for header in require(side.get('headers', []), list):
        header = require(header, dict)
        original = require(header['name'], str)
        value = require(header['value'], str)
        name = original.lower()
        values[name].append(value)
        sources.structural_occurrence(original)
        # Check the original spelling before lowercasing can hide token-like casing.
        if blob_like(original, 'headers'):
            sources.remember(original)
        if (name == 'content-type' and mime_type(value)) or (
                not response and name == 'accept' and accept_type(value)):
            sources.structural_occurrence(value)
            if name == 'content-type' and ';' in value:
                mime_header(value, 'Content-Type', sources)
        elif name in ('authorization', 'proxy-authorization'):
            credentials = value.split(maxsplit=1)
            if len(credentials) == 2:
                sources.remember_secret(credentials[1].strip())
        if name in origin_headers and bank_origin(value):
            sources.structural_occurrence(value)
        elif not response and authority and (
                (name in ('host', ':authority') and value.lower() == authority.split('://')[1])
                or (name in ('origin', 'referer') and value.lower() == authority)
                or (name == ':path' and value == target)):
            sources.structural_occurrence(value)
        if name != ('set-cookie' if response else 'cookie'):
            names.add(name)
    cookies = require(side.get('cookies', []), list)
    for cookie in cookies:
        cookie = require(cookie, dict)
        sources.remember_secret(require(cookie['name'], str))
        sources.remember_secret(require(cookie['value'], str))
    cookie_count = len(cookies)
    if response and 'set-cookie' in values:
        cookie_count = sum(remember_cookie(line.partition(';')[0], sources)
                           for value in values['set-cookie'] for line in value.splitlines())
    elif not response and 'cookie' in values:
        cookie_count = sum(remember_cookie(part, sources)
                           for value in values['cookie'] for part in value.split(';'))
    return {'headers': sorted(names), 'set_cookie_count' if response else 'cookie_count': cookie_count}, values


def first_header(values, name):
    return values[name][0] if name in values else ''


def remember_multipart_payload(part, sources):
    sources.remember(part.get_filename())
    if part.is_multipart():
        for child in part.iter_parts():
            remember_multipart_payload(child, sources)
    else:
        payload = part.get_payload(decode=True)
        if payload:
            if is_json_mime(part.get_content_type()) and payload.strip():
                sources.remember(parse_json(payload))
            else:
                remember_opaque_text(payload.decode('utf-8', errors='replace'), sources)
    if part.defects:
        raise InvalidInput


def multipart_names(text, raw_mime, sources):
    if '\r' in raw_mime or '\n' in raw_mime:
        raise InvalidInput
    message = BytesParser(policy=policy.default).parsebytes(
        f'Content-Type: {raw_mime}\r\n\r\n{text}'.encode('utf-8'))
    if not message.is_multipart() or message.defects:
        raise InvalidInput
    names = []
    for part in message.iter_parts():
        name = part.get_param('name', header='content-disposition')
        if part.defects or part.get_content_disposition() != 'form-data' or not isinstance(name, str):
            raise InvalidInput
        names.append(name)
        remember_multipart_payload(part, sources)
    return names


def is_json_mime(mime):
    return mime == 'application/json' or mime.endswith('+json')


def request_body(request, headers, sources):
    if 'postData' not in request:
        return {'body': '<omitted>'}
    post = require(request['postData'], dict)
    declared_mime = require(post.get('mimeType', ''), str)
    raw_mime = declared_mime or first_header(headers, 'content-type')
    mime = mime_type(raw_mime)
    if declared_mime and mime:
        sources.structural_occurrence(declared_mime)
        if ';' in declared_mime:
            mime_header(declared_mime, 'Content-Type', sources)
    text = require(post.get('text', ''), str)
    declared = declared_pairs(post.get('params', []), sources)
    if mime == FORM:
        body = pair_shape(encoded_pairs(text, sources, from_post=True) if text else declared)
    elif is_json_mime(mime):
        body = parsed_json_shape(text, sources)
    elif mime == MULTIPART:
        names = multipart_names(text, raw_mime, sources) if text else [name for name, _ in declared]
        body = [{'name': name} for name in sorted(names)]
    else:
        remember_opaque_text(text, sources)
        size = require(request.get('bodySize', -1), int)
        if size < 0 and text:
            size = len(text.encode('utf-8'))
        body = f'<body:{mime or "unknown"}:{bucket(size, SIZE_BOUNDS)}>'
    return {'mime': mime or '<omitted>', 'body': body}


def parsed_json_shape(text, sources):
    if not text:
        return '<omitted>'
    data = parse_json(text)
    sources.remember(data)
    return json_shape(data)


def web_structure(text, match, literal, sources, web_mime):
    start, end = match.span()
    # Recognize local syntax without rescanning the prefix of a large web asset.
    before = text[max(0, start - 64):start]
    if web_mime == 'text/css':
        return PATH.fullmatch(literal) is not None and CSS_ROUTE_START.search(before) is not None
    if mime_type(literal) and WEB_MIME_START.search(before):
        if ';' in literal:
            mime_header(literal, 'Content-Type', sources)
        return True
    if before.rstrip().endswith(('{', ',')) and WEB_PROPERTY_END.match(text, end):
        return True
    return PATH.fullmatch(literal) is not None and JS_ROUTE_START.search(before) is not None


def remember_tokens(text, sources):
    for match in TOKEN.finditer(text):
        sources.remember(match[0])


def remember_text(text, sources, *, web_mime=None):
    sources.remember(text)
    sources.remember(text.splitlines())
    if web_mime is None:
        remember_tokens(text, sources)
        return
    end = 0
    for match in WEB_LITERAL.finditer(text):
        remember_tokens(text[end:match.start()], sources)
        quoted = match['quoted']
        if quoted:
            literal = quoted[1:-1]
            if not web_structure(text, match, literal, sources, web_mime):
                sources.remember(literal)
                remember_tokens(literal, sources)
        else:
            remember_tokens(match[0], sources)
        end = match.end()
    remember_tokens(text[end:], sources)


def remember_opaque_text(text, sources, *, web_mime=None):
    if text.lstrip().startswith(('{', '[')):
        try:
            data = parse_json(text)
        except ValueError:
            pass
        else:
            sources.remember(data)
            return
    remember_text(text, sources, web_mime=web_mime)


class HtmlValues(HTMLParser):
    def __init__(self, sources):
        super().__init__()
        self.sources = sources
        self.code_mime = None

    def handle_starttag(self, tag, attrs):
        if tag == 'script':
            declared = (dict(attrs).get('type') or '').strip().lower()
            mime = mime_type(declared)
            if declared in ('', 'module'):
                self.code_mime = 'text/javascript'
            else:
                self.code_mime = mime if mime in SCRIPT_MIMES or is_json_mime(mime) else ''
        elif tag == 'style':
            declared = (dict(attrs).get('type') or '').strip()
            self.code_mime = 'text/css' if not declared or mime_type(declared) == 'text/css' else ''
        for name, value in attrs:
            if not value:
                continue
            if name == 'type' and tag in HTML_MIME_TAGS and mime_type(value):
                if ';' in value:
                    mime_header(value, 'Content-Type', self.sources)
            elif tag not in HTML_ROUTE_ATTRIBUTES.get(name, ()) or not PATH.fullmatch(value):
                remember_text(value, self.sources)

    def handle_endtag(self, tag):
        if tag in ('script', 'style'):
            self.code_mime = None

    def handle_data(self, data):
        if self.code_mime is not None:
            wrapped = data.strip()
            if wrapped.startswith('<![CDATA['):
                data = CDATA_TEXT.sub(r'\1', data)
        if self.code_mime is not None and is_json_mime(self.code_mime):
            if data.strip():
                self.sources.remember(parse_json(data))
        else:
            remember_text(data, self.sources, web_mime=self.code_mime or None)

    def handle_comment(self, data):
        remember_text(data, self.sources)

    def handle_decl(self, decl):
        remember_text(decl, self.sources)

    def handle_pi(self, data):
        remember_text(data.removesuffix('?'), self.sources)

    def unknown_decl(self, data):
        remember_text(data.removeprefix('CDATA['), self.sources)

    def close(self):
        super().close()
        if self.code_mime is not None:
            raise InvalidInput


def xml_tags(text, sources):
    tags = {}
    parser = expat.ParserCreate()
    parser.buffer_text = True

    def start_tag(name, attrs):
        tags[name] = None
        for value in attrs.values():
            sources.remember(value)

    def reject_doctype(*_args):
        raise InvalidInput

    parser.StartElementHandler = start_tag
    parser.StartDoctypeDeclHandler = reject_doctype
    parser.CharacterDataHandler = lambda value: remember_text(value, sources)
    parser.CommentHandler = lambda value: remember_text(value, sources)
    parser.ProcessingInstructionHandler = lambda _, value: remember_text(value, sources)
    parser.Parse(text, True)
    return list(tags)


def ofx_tags(text, sources):
    try:
        document = text.decode('utf-8-sig')
    except UnicodeDecodeError:
        document = text.decode('latin-1')
    tags = {}
    end = 0
    for match in SGML.finditer(document):
        gap = document[end:match.start()]
        if '<' in gap:
            raise InvalidInput
        remember_text(html.unescape(gap), sources)
        if match['tag'] and not match['closing']:
            tags.setdefault(match['tag'].upper(), None)
        elif not match['tag']:
            remember_text(match['comment'] or match['cdata'] or '', sources)
        end = match.end()
    tail = document[end:]
    if '<' in tail or next(iter(tags), None) != 'OFX':
        raise InvalidInput
    remember_text(tail, sources)
    return list(tags)


def disposition_shape(value, sources):
    message = mime_header(value, 'Content-Disposition', sources)
    kind = message.get_content_disposition()
    if kind not in ('attachment', 'inline'):
        return '<omitted>', ''
    extended = next((param for key, param in message.get_params(header='Content-Disposition', failobj=[])[1:]
                     if key == 'filename' and isinstance(param, tuple)), None)
    filename = collapse_rfc2231_value(extended, errors='strict') if extended else message.get_filename() or ''
    extension = EXTENSION.search(filename.lower())
    if extension:
        return f'{kind}; filename=<name>{extension[0]}', extension[0]
    return kind, ''


def response_shape(response, sources):
    result, headers = header_shape(response, sources, response=True)
    redirect = response.get('redirectURL')
    if (isinstance(redirect, str) and bank_origin(redirect)
            and any(redirect.strip().casefold() == value.strip().casefold()
                    for value in headers.get('location', ()))):
        sources.structural_occurrence(redirect)
    content = require(response.get('content', {}), dict)
    declared_mime = require(content.get('mimeType', ''), str)
    mime = mime_type(declared_mime) or mime_type(first_header(headers, 'content-type'))
    if mime_type(declared_mime):
        sources.structural_occurrence(declared_mime)
        if ';' in declared_mime:
            mime_header(declared_mime, 'Content-Type', sources)
    status = require(response['status'], int)
    if status != 0 and not 100 <= status <= 599:
        raise InvalidInput
    size = require(content.get('size', -1), int)
    if size < 0:
        size = require(response.get('bodySize', -1), int)
    disposition, extension = disposition_shape(first_header(headers, 'content-disposition'), sources)
    text = require(content.get('text', ''), str)
    encoding = require(content.get('encoding', ''), str)
    body = '<omitted>'
    is_json = is_json_mime(mime)
    is_xml = (mime in ('text/xml', 'application/xml') or mime.endswith('+xml')) and mime not in WEB_MIMES
    qfx_filename = extension in ('.ofx', '.qfx')
    opaque = mime in WEB_MIMES or mime.startswith(('audio/', 'font/', 'image/', 'video/'))
    possible_ofx = mime in DOWNLOAD_MIMES or (qfx_filename and not opaque)
    declared_ofx = mime in OFX_MIMES or (qfx_filename and mime in DOWNLOAD_MIMES)
    if text and (is_json or is_xml or declared_ofx or possible_ofx):
        if encoding not in ('', 'base64'):
            raise InvalidInput
        decoded = base64.b64decode(text, validate=True) if encoding == 'base64' else text.encode('utf-8')
        if is_json:
            body = parsed_json_shape(decoded, sources)
        elif is_xml:
            body = xml_tags(decoded if encoding else text, sources)
        else:
            start = decoded.removeprefix(b'\xef\xbb\xbf').lstrip()
            if start.startswith(b'<?xml'):
                tags = xml_tags(decoded if encoding else text, sources)
                if tags[0].upper() == 'OFX':
                    body = tags
                elif declared_ofx:
                    raise InvalidInput
            elif declared_ofx or OFX_START.match(start):
                body = ofx_tags(decoded, sources)
            else:
                remember_opaque_text(decoded.decode('utf-8', errors='replace'), sources)
    elif text:
        if encoding == 'base64' and not mime.startswith(('audio/', 'font/', 'image/', 'video/')):
            text = base64.b64decode(text, validate=True).decode('utf-8', errors='replace')
        if mime in HTML_MIMES:
            parser = HtmlValues(sources)
            parser.feed(text)
            parser.close()
        else:
            remember_opaque_text(text, sources, web_mime=mime if mime in WEB_MIMES else None)
    result.update(status=status, mime=mime or '<omitted>', size_bucket=bucket(size, SIZE_BOUNDS),
                  disposition=disposition, body=body)
    return result


def har_start(value):
    timestamp = HAR_TIME.fullmatch(require(value, str))
    if not timestamp:
        raise InvalidInput
    fraction = (timestamp['fraction'] or '')[:6].ljust(6, '0')
    offset = timestamp['offset']
    if offset == 'Z':
        offset = '+00:00'
    elif len(offset) == 5:
        offset = offset[:3] + ':' + offset[3:]
    return datetime.fromisoformat(f"{timestamp['clock']}.{fraction}{offset}")


def make_skeleton(document, include_host, sources):
    log = require(require(document, dict)['log'], dict)
    entries = require(log['entries'], list)
    output = []
    counts = Counter()
    first = None
    for index, entry in enumerate(entries):
        entry = require(entry, dict)
        started = har_start(entry['startedDateTime'])
        if first is None:
            first = started
        request = require(entry['request'], dict)
        method = require(request['method'], str)
        if not HTTP_TOKEN.fullmatch(method):
            raise InvalidInput
        origin, path, pairs, authority, target = url_shape(require(request['url'], str), include_host, sources)
        declared = declared_pairs(request.get('queryString', []), sources)
        request_info, headers = header_shape(request, sources, authority=authority, target=target)
        content_type = mime_type(first_header(headers, 'content-type'))
        accept = accept_type(first_header(headers, 'accept'))
        if content_type:
            request_info['content_type'] = content_type
        if accept:
            request_info['accept'] = accept
        request_info.update(request_body(request, headers, sources))
        response = response_shape(require(entry['response'], dict), sources)
        duration = entry.get('time', -1)
        if type(duration) not in (int, float):
            raise InvalidInput
        output.append({'index': index, 'relative_seconds': round((started - first).total_seconds()),
                       'duration_ms_bucket': bucket(duration, DURATION_BOUNDS),
                       'method': method if method in METHODS else '<method>',
                       'origin': origin, 'path': path, 'query': pair_shape(pairs or declared),
                       'request': request_info, 'response': response})
        counts[path] += 1
    return {'entries': output, 'path_counts': [{'path': path, 'count': count}
                                               for path, count in sorted(counts.items())]}


def self_check(output, sources):
    forbidden = sources.forbidden_prefixes()
    offenders = []

    def scan(value, location, field):
        if isinstance(value, dict):
            for index, (key, child) in enumerate(value.items()):
                if key in FIXED_FIELDS:
                    scan(child, f'{location}.{key}', key)
                else:
                    if suspect(key):
                        offenders.append(f'{location}.key[{index}]')
                    scan(child, f'{location}.value[{index}]', '')
        elif isinstance(value, list):
            for index, item in enumerate(value):
                scan(item, f'{location}[{index}]', field)
        elif isinstance(value, str):
            if value in GENERATED_STRINGS.get(field, ()):
                return
            if field == 'body' and value.startswith('<body:') and value.endswith('>'):
                mime, _, size = value[6:-1].rpartition(':')
                if size in SAFE_BUCKETS['size_bucket']:
                    if mime == 'unknown':
                        return
                    if MIME.fullmatch(mime):
                        if suspect(mime, 'mime'):
                            offenders.append(location)
                        return
            valid = field not in ('name', 'headers') or name_ok(value, field)
            if field == 'path':
                valid = bool(PATH.fullmatch(value))
            elif field == 'disposition' and (match := DISPOSITION.fullmatch(value)):
                value = match[1]
            if not valid or suspect(value, field):
                offenders.append(location)
        elif type(value) is not int or not NUMERIC_LOCATIONS.fullmatch(location):
            offenders.append(location)

    def suspect(value, field=''):
        lowered = value.casefold()
        if not value.isascii() or re.search(r'[\x00-\x1f\x7f]', value):
            return True
        if has_email(value) or any(pattern.search(value) for pattern in (DIGITS, DATE, TEXT_DATE, MONEY, JWT)):
            return True
        if blob_like(value, field):
            return True
        if sources.short_secrets and copied_short_secret(lowered, field, sources.short_secrets):
            return True
        allowed_copies = ('/<token>',) if field == 'path' else ()
        return any(lowered.startswith(source, index)
                   for index in range(len(lowered) - 3)
                   for source in forbidden.get(lowered[index:index + 4], ())
                   if source not in allowed_copies)

    scan(output, '$', '')
    return sorted(set(offenders))


def copied_short_secret(value, field, secrets):
    if field == 'path':
        atoms = [part for part in value.split('/') if part not in ('<id>', '<token>')]
    elif field == 'origin':
        host = value.partition('://')[2]
        atoms = [value, host, *host.split('.')]
    elif field in ('mime', 'accept', 'content_type', 'body') and MIME.fullmatch(value):
        subtype = value.partition('/')[2]
        atoms = [value, subtype, *re.split(r'[.+]', subtype)]
    elif field == 'disposition' and EXTENSION.fullmatch(value):
        atoms = [value, value[1:]]
    elif field in ('name', 'headers', 'body'):
        atoms = [value]
    else:
        return False
    return not secrets.isdisjoint(atoms)


def name_word(part):
    words = [re.sub(r'\d{1,3}$', '', word) for word in CAMEL_BOUNDARY.split(part)]
    if not all(word.isalpha() for word in words):
        return False
    if len(words) == 1:
        word, = words
        return len(word) < 16 and (word.islower() or word.isupper() or
                                  len(word) >= 3 or word.lower() in SHORT_NAME_WORDS)
    return all(word in NAME_ACRONYMS if word.isupper()
               else len(word) >= 3 or word.lower() in SHORT_NAME_WORDS for word in words)


def blob_like(value, field):
    if field == 'path':
        # Keep adjacent token-like segments together because slash is a base64 character.
        value = '/'.join('.' if name_word(part) and not HEX_BLOB.search(part) else part
                         for part in value.split('/'))
        pieces = value.split('.')
    elif field in ('accept', 'content_type', 'mime') and MIME.fullmatch(value):
        pieces = value.removesuffix('+json').removesuffix('+xml').split('/')
    elif field == 'origin':
        pieces = value.split('/')
    else:
        pieces = [value]
    structural = field in ('accept', 'body', 'content_type', 'headers', 'mime', 'name', 'origin')
    for piece in pieces:
        for match in BLOB.finditer(piece):
            candidate = match[0].strip('/')
            if len(candidate) < 16 or (field == 'body' and candidate.casefold() in LONG_OFX_TAGS):
                continue
            if HEX_BLOB.search(candidate) or not (structural and all(
                    name_word(part) for part in re.split(r'[-_]', candidate))):
                return True
    return False


def name_ok(value, field):
    if field == 'headers':
        return bool(HTTP_TOKEN.fullmatch(value) or (value.startswith(':') and HTTP_TOKEN.fullmatch(value[1:])))
    return bool(NAME.fullmatch(value))


def write_private(path, payload, force):
    fd, temporary = tempfile.mkstemp(prefix='.har-skeleton-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as output:
            if os.name == 'posix':
                os.fchmod(output.fileno(), 0o600)
            output.write(payload)
        if force:
            os.replace(temporary, path)
        elif os.name == 'nt':
            os.rename(temporary, path)  # On Windows rename fails if the destination exists.
        else:
            os.link(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def main():
    parser = ArgumentParser(prog='har_skeleton.py', allow_abbrev=False,
                            description='Create a structural JSON outline of a local HAR.',
                            epilog='Review the output yourself before sharing. Delete the HAR afterwards. '
                                   'This tool does not make the HAR itself safe.')
    parser.add_argument('input', metavar='in.har', type=Path)
    parser.add_argument('-o', metavar='out.json', type=Path, help='write to a private file instead of stdout')
    parser.add_argument('--include-host-pattern', metavar='REGEX', help='retain normalized hosts matching the full regex')
    parser.add_argument('--force', action='store_true', help='replace an existing output file')
    try:
        args = parser.parse_args()
        if args.force and args.o is None:
            raise InvalidArguments
        include_host = re.compile(args.include_host_pattern, re.ASCII) if args.include_host_pattern else None
    except (InvalidArguments, re.error, OverflowError, RecursionError):
        print('Invalid arguments. See --help.', file=sys.stderr)
        return 2
    try:
        document = parse_json(args.input.read_text(encoding='utf-8-sig'))
        sources = InputValues(document)
        outline = make_skeleton(document, include_host, sources)
        offenders = self_check(outline, sources)
        if offenders:
            print('\n'.join(offenders), file=sys.stderr)
            return 1
        payload = json.dumps(outline, indent=2, ensure_ascii=True) + '\n'
    except (Exception, KeyboardInterrupt):
        print('Could not read or process the HAR.', file=sys.stderr)
        return 1
    try:
        if args.o is None:
            sys.stdout.write(payload)
            sys.stdout.flush()
        else:
            if args.o.exists() and args.input.samefile(args.o):
                raise InvalidArguments
            write_private(args.o, payload, args.force)
    except FileExistsError:
        print('Output already exists. Use --force to replace it.', file=sys.stderr)
        return 1
    except (Exception, KeyboardInterrupt):
        print('Could not write the skeleton.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
