#!/usr/bin/env python3
"""Produce a checked, structural JSON outline of a browser HAR."""

import argparse
import base64
from collections import Counter, defaultdict
from contextlib import nullcontext
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
import warnings
from xml.parsers import expat


VERSION = '1.3.0'
BANK_DOMAINS = ('chase.com', 'jpmorgan.com', 'jpmorganchase.com', 'jpmchase.com')
URL_SCHEMES = frozenset({'http', 'https', 'ws', 'wss'})
METHODS = frozenset('GET HEAD POST PUT DELETE CONNECT OPTIONS TRACE PATCH PROPFIND '
                    'PROPPATCH MKCOL COPY MOVE LOCK UNLOCK REPORT SEARCH'.split())
HTTP_TOKEN = re.compile(r"[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}")
NAME = re.compile(r'[A-Za-z_][A-Za-z0-9_.:\-\[\]]{0,127}')
HOST = re.compile(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?')
ROUTE_SEGMENT = re.compile(r'[A-Za-z]{1,11}|v[0-9]{1,2}')
PATH = re.compile(rf'(?:/(?:{ROUTE_SEGMENT.pattern}|<id>|<token>)?)+')
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
SCRIPT_MIMES = frozenset('''
    application/ecmascript application/javascript application/x-ecmascript application/x-javascript
    text/ecmascript text/javascript text/javascript1.0 text/javascript1.1 text/javascript1.2
    text/javascript1.3 text/javascript1.4 text/javascript1.5 text/jscript text/livescript
    text/x-ecmascript text/x-javascript
'''.split())
WEB_MIMES = HTML_MIMES | SCRIPT_MIMES | {'text/css'}
STATIC_TEXT_MIMES = WEB_MIMES | {'application/source-map', 'application/x-sourcemap', 'image/svg+xml'}
STATIC_BINARY_MIMES = {'application/wasm', 'application/font-woff', 'application/font-sfnt',
                       'application/vnd.ms-fontobject'}
STATIC_BINARY_PREFIXES = ('audio/', 'font/', 'image/', 'video/')
STATIC_RESOURCES = frozenset({'script', 'stylesheet', 'font', 'image', 'media', 'sourcemap'})
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
LONG_ALNUM = re.compile(r'[A-Za-z0-9]{16,}')
EMBEDDED_DIGITS = re.compile(r'(?<=[A-Za-z])[0-9]+(?=[A-Za-z])')
CAMEL_BOUNDARY = re.compile(r'(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])')
SHORT_NAME_WORDS = frozenset('a an as at by for id if in no of on or to ui uk us'.split())
NAME_ACRONYMS = frozenset('ABA ACH API APR APY ATM BIC BIN CSP CSRF CSV CVV DNS HTML HTTP HTTPS IBAN ID IP '
                          'IRA ISO JSON JWT MFA MIME NFC OFX OTP PAN PCI PDF PIN QFX SAML SDK SSN SSO SWIFT TIN '
                          'TLS UI URI URL UTF UUID XML'.split())
LONG_OFX_TAGS = frozenset({'creditcardmsgsrqv1', 'creditcardmsgsrsv1'})
OFX_VERSION_TAGS = frozenset({
    'SIGNONMSGSRQV1', 'SIGNONMSGSRSV1', 'SIGNUPMSGSRQV1', 'SIGNUPMSGSRSV1',
    'BANKMSGSRQV1', 'BANKMSGSRSV1', 'CREDITCARDMSGSRQV1', 'CREDITCARDMSGSRSV1',
    'INVSTMTMSGSRQV1', 'INVSTMTMSGSRSV1', 'SECLISTMSGSRQV1', 'SECLISTMSGSRSV1',
    'PROFMSGSRQV1', 'PROFMSGSRSV1',
})
TAG_NAME = re.compile(r'[A-Za-z_][A-Za-z0-9_.:-]{0,127}')
DIGIT = re.compile(r'\d')
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
JSON_DEPTH_LIMIT = 6
JSON_KEY_LIMIT = 40
KEY_TEMPLATES = frozenset({'<num-key>', '<key:email>', '<key:route>', '<key:opaque>', '<key:other>'})
TAG_TEMPLATE = '<tag:opaque>'
AUTH_ROUTE = re.compile(r'(?:^|[^a-z0-9])(?:log[-_]?(?:in|on)|sign[-_]?in|auth(?:entication|enticate)?|oauth2?|'
                        r'sso|credentials|session|mfa|token|callback|recover(?:y)?|reset[-_]?password)'
                        r'(?:[^a-z0-9]|$)', re.I)
SECRET_FIELD = re.compile(r'(?:^|[^a-z0-9])(?:password|passwd|passcode|pwd|pin|credential[s]?|'
                          r'secret[s]?|private|auth(?:entication|orization)?|bearer|token|csrf|xsrf|session|'
                          r'otp|(?:api|access|refresh)[-_]?key|device|principal|'
                          r'(?:user|customer|first|last|full|legal)[-_]?name|'
                          r'(?:recovery|security)[-_]?answer)(?:[^a-z0-9]|$)', re.I)
COMPACT_CREDENTIAL = re.compile(r'(?:session|csrf|xsrf|auth|access|refresh|api)(?:id|token|key)$', re.I)
PRIVATE_VALUE = re.compile(r'^(?:private|secret|credential|password|session|csrf|xsrf|bearer|token)(?=[A-Z_.-])')
TOKEN = re.compile(r'''[^\s"'=<>{}(),;]+''')
MIME_PARAMETER = re.compile(r';\s*((?:"(?:[^"\\]|\\.)*"|[^";])*)')
CDATA_TEXT = re.compile(r'<!\[CDATA\[(.*?)\]\]>', re.S)
WEB_LITERAL = re.compile(r'''(?P<comment>/\*.*?\*/|//[^\r\n]*)|'''
                         r'''(?P<quoted>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)''', re.S)
WEB_PROPERTY_END = re.compile(r'\s*:')
ASSET_LITERAL = r'''"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`'''
ASSET_FIELD = re.compile(rf'(?P<name>{ASSET_LITERAL}|[A-Za-z_$][\w.$-]{{0,127}})\s*[:=]\s*'
                         rf'(?P<value>{ASSET_LITERAL}|[0-9]+)')
ASSET_TOKEN = re.compile(r'''[^\s"'`=<>{}(),;!?]+''')
ASSET_ESCAPE = re.compile(r'\\(?:u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([\\\'"`/]))')
ASSET_HEADER_LITERALS = frozenset({'authorization', 'content-type', 'cookie', 'set-cookie',
                                   'x-csrf-token', 'x-xsrf-token', 'x-device-id', 'x-session-id',
                                   'x-api-key', 'x-access-key'})
ASSET_HEADER_REGISTRY = re.compile(r'\b(?:headerNames|headersRegistry|HEADER_NAMES)\s*[:=]\s*\{[^{}]{0,4096}\Z')
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
CORS_HEADER_LISTS = (
    ('request', 'access-control-request-headers', 'request'),
    ('response', 'access-control-allow-headers', 'request'),
    ('response', 'access-control-expose-headers', 'response'),
)
CORS_PREFLIGHT_NAMES = frozenset({'accept', 'authorization', 'content-type'})
STRICT_VALUE_HEADERS = frozenset(name for _, name, _ in CORS_HEADER_LISTS) | {
    ':path', 'accept', 'cookie', 'set-cookie', 'location', 'referer', 'origin',
}
BROWSER_METADATA_ENUMS = {
    '_priority': frozenset('verylow low medium high veryhigh'.split()),
    '_resourceType': frozenset('document stylesheet image media font script texttrack xhr fetch prefetch '
                               'eventsource websocket manifest signedexchange ping cspviolationreport '
                               'preflight fedcm other webtransport webbundle'.split()),
}
RAW_ENTRY_KINDS = {
    ('request', 'url'): 'url',
}
PARSED_RAW_PATHS = frozenset({
    ('request', 'queryString', '*', 'value'),
    ('request', 'postData', 'params', '*', 'value'),
    ('request', 'postData', 'text'),
    ('response', 'content', 'text'),
})
for _side in ('request', 'response'):
    RAW_ENTRY_KINDS[(_side, 'headers', '*', 'value')] = 'header-value'
    for _field in ('name', 'value'):
        RAW_ENTRY_KINDS[(_side, 'cookies', '*', _field)] = 'cookie'


class InvalidInput(ValueError):
    pass


class InvalidArguments(ValueError):
    pass


class ArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        raise InvalidArguments


def scalars(value):
    pending = [value]
    while pending:
        value = pending.pop()
        if isinstance(value, dict):
            pending.extend(value.values())
        elif isinstance(value, list):
            pending.extend(value)
        elif isinstance(value, str) or type(value) in (int, float):
            yield str(value).strip()


def secret_field(name):
    normalized = CAMEL_BOUNDARY.sub('-', name)
    return (SECRET_FIELD.search(normalized) is not None or
            any(COMPACT_CREDENTIAL.fullmatch(part) for part in re.split(r'[-_.]', normalized)))


def auth_path(path):
    return AUTH_ROUTE.search(CAMEL_BOUNDARY.sub('-', unquote(path))) is not None


def looks_sensitive(text):
    lowered = text.lower()
    if (DIGITS.search(text) or has_email(text) or JWT.search(text) or UUID.search(text) or PRIVATE_VALUE.search(text)
            or DATE.search(text) or TEXT_DATE.search(text) or MONEY.search(text)
            or '?' in text or '#' in text or not text.isascii()):
        return True
    if structured_origin(lowered) or MIME.fullmatch(lowered):
        field = 'mime' if MIME.fullmatch(lowered) else 'origin'
        return opaque_alphanumeric(lowered, field) or HEX_BLOB.search(lowered) is not None
    if PATH.fullmatch(text):
        return False
    if opaque_alphanumeric(text, 'name') or blob_like(text, 'name'):
        return True
    # Conventional identifiers can be labels in config or localization dictionaries.
    return not NAME.fullmatch(text)


def strict_header_value(name):
    return name.lower() in STRICT_VALUE_HEADERS or secret_field(name)


def source_path(path):
    return tuple('*' if isinstance(part, int) else None if part == '*' else part for part in path)


def sensitive_scalars(value, *, selective=False):
    for text in scalars(value):
        if (len(text) >= 8 or DIGITS.search(text)) and (not selective or looks_sensitive(text)):
            yield text.casefold()


def raw_values(value, path=()):
    entry_path = source_path(path[3:]) if path[:2] == ('log', 'entries') and (
        len(path) >= 3 and isinstance(path[2], int)) else None
    if entry_path in PARSED_RAW_PATHS:
        # The body and pair parsers classify their originals and decoded values together.
        return
    if isinstance(value, dict):
        for key, child in value.items():
            if key == 'value' and entry_path is not None and RAW_ENTRY_KINDS.get(
                    entry_path + ('value',)) == 'header-value':
                name = value.get('name')
                selective = isinstance(name, str) and not strict_header_value(name)
                for text in sensitive_scalars(child, selective=selective):
                    yield text, 'header-value'
                continue
            yield from raw_values(child, (*path, key))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from raw_values(child, (*path, index))
    else:
        kind = RAW_ENTRY_KINDS.get(entry_path, 'har-metadata')
        for text in sensitive_scalars(value):
            yield text, kind


class InputValues:
    """Track raw data and values extracted by the format-specific parsers."""

    def __init__(self, document, *, diagnose=False):
        self.values = set()
        self.short_secrets = set()
        self.raw_kinds = defaultdict(Counter) if diagnose else None
        self.parsed_kinds = defaultdict(set) if diagnose else None
        self.short_kinds = defaultdict(set) if diagnose else None
        self.raw = Counter()
        for value, kind in raw_values(document):
            self.raw[value] += 1
            if diagnose:
                self.raw_kinds[kind][value] += 1

    def remember(self, value, kind, *, selective=False):
        for text in sensitive_scalars(value, selective=selective):
            self.values.add(text)
            if self.parsed_kinds is not None:
                self.parsed_kinds[kind].add(text)

    def structural_occurrence(self, value, kind='har-metadata', *, selective=False):
        """Exclude one raw occurrence, preserving copies from other sources."""
        for text in sensitive_scalars(value, selective=selective):
            self.raw[text] -= 1
            if self.raw_kinds is not None:
                self.raw_kinds[kind][text] -= 1

    def header_occurrence(self, name, value):
        self.structural_occurrence(value, 'header-value', selective=not strict_header_value(name))

    def remember_secret(self, value, kind):
        value = value.strip()
        if 0 < len(value) < 8:
            text = value.casefold()
            self.short_secrets.add(text)
            if self.short_kinds is not None:
                self.short_kinds[kind].add(text)
        else:
            self.remember(value, kind)

    def source_kinds(self, value, short):
        if short:
            return {kind for kind, values in self.short_kinds.items() if value in values}
        kinds = {kind for kind, values in self.parsed_kinds.items() if value in values}
        if self.raw[value] > 0:
            kinds.update(kind for kind, values in self.raw_kinds.items() if values[value] > 0)
        return kinds or {'har-metadata'}

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
    'type': VALUE_HINTS | {'<max-depth>'},
    'first': VALUE_HINTS | {'<max-depth>'},
    'name': KEY_TEMPLATES | {'<more-keys>'},
    'headers': KEY_TEMPLATES,
    'body': VALUE_HINTS | {'<omitted>', '<max-depth>', TAG_TEMPLATE},
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


def name_shape(name, field='name'):
    if name.isdecimal():
        return '<num-key>'
    if has_email(name):
        return '<key:email>'
    if '/' in name:
        return '<key:route>'
    if not name_ok(name, field):
        return '<key:other>'
    if any(suspect(name, field)):
        return '<key:opaque>'
    return name


def shaped_names(items, sources):
    fields = []
    templated = Counter()
    for name, hint in items:
        shaped = name_shape(name)
        if shaped in KEY_TEMPLATES:
            templated[shaped] += 1
            if not PATH.fullmatch(name):
                sources.remember(name, 'templated-name')
            continue
        field = {'name': name}
        if hint is not None:
            field['type'] = hint
        fields.append(field)
    fields.extend({'name': name, 'count_bucket': bucket(count, COUNT_BOUNDS)}
                  for name, count in sorted(templated.items()))
    return fields


def json_shape(value, depth=0):
    if depth >= JSON_DEPTH_LIMIT and isinstance(value, (dict, list)):
        return '<max-depth>'
    if isinstance(value, dict):
        fields = []
        templated = Counter()
        remaining = 0
        for name, child in sorted(value.items()):
            if name.startswith('_'):
                continue
            shaped = name_shape(name)
            if shaped in KEY_TEMPLATES:
                templated[shaped] += 1
            elif len(fields) < JSON_KEY_LIMIT:
                fields.append({'name': name, 'type': json_shape(child, depth + 1)})
            else:
                remaining += 1
        fields.extend({'name': name, 'count_bucket': bucket(count, COUNT_BOUNDS)}
                      for name, count in sorted(templated.items()))
        if remaining:
            fields.append({'name': '<more-keys>', 'count_bucket': bucket(remaining, COUNT_BOUNDS)})
        return {'fields': fields}
    if isinstance(value, list):
        result = {'count_bucket': bucket(len(value), COUNT_BOUNDS)}
        if value:
            result['first'] = json_shape(value[0], depth + 1)
        return result
    return value_hint(value)


def mime_type(value):
    mime = value.partition(';')[0].strip().lower()
    return mime if MIME.fullmatch(mime) else ''


def accept_type(value):
    candidate = value.strip().lower()
    return candidate if MIME.fullmatch(candidate) or candidate == '*/*' else ''


def remember_pair(name, value, kind, sources, *, strict=False):
    if strict or secret_field(name):
        sources.remember_secret(value, kind)
    else:
        sources.remember(value, kind, selective=True)


def encoded_pairs(text, sources, *, from_post=False, strict=False):
    if re.search(r'%(?![0-9a-fA-F]{2})', text):
        raise InvalidInput
    pairs = parse_qsl(text, keep_blank_values=True, errors='strict')
    names = {name.lower() for name, _ in pairs}
    strict = strict or {'code', 'state'} <= names
    kind = 'form-value' if from_post else 'query-value'
    for name, value in pairs:
        remember_pair(name, value, kind, sources, strict=strict)
    for parameter in text.split('&'):
        name, _, value = parameter.partition('=')
        if '%' in value or '+' in value:
            remember_pair(unquote_plus(name), value, kind, sources, strict=strict)
    if '=' in text or '&' in text:
        sources.remember([text, unquote_plus(text, errors='strict')], 'form-text' if from_post else 'query-string')
    return pairs


def declared_pairs(items, sources, kind, *, strict=False):
    pairs = []
    for item in require(items, list):
        item = require(item, dict)
        name = require(item['name'], str)
        value = require(item.get('value', ''), str)
        sources.structural_occurrence(name)
        pairs.append((name, value))
    names = {name.lower() for name, _ in pairs}
    for name, value in pairs:
        remember_pair(name, value, kind, sources, strict=strict or {'code', 'state'} <= names)
    return pairs


def pair_shape(pairs, sources):
    return shaped_names(((name, value_hint(value)) for name, value in sorted(pairs, key=lambda pair: pair[0])),
                        sources)


def bank_host(host):
    return (any(host == bank or host.endswith('.' + bank) for bank in BANK_DOMAINS)
            and all(HOST.fullmatch(label) for label in host.split('.')))


def bank_origin(value):
    scheme, _, host = value.strip().lower().partition('://')
    return scheme in URL_SCHEMES and bank_host(host)


def decoded_path_parts(path):
    parts = []
    for segment in (path or '/').split('/'):
        if re.search(r'%(?![0-9a-fA-F]{2})', segment):
            raise InvalidInput
        parts.append((segment, unquote(segment, errors='strict')))
    return parts


def path_template(parts, sources):
    path = []
    for raw, decoded in parts:
        if not decoded or ROUTE_SEGMENT.fullmatch(decoded):
            path.append(decoded)
        else:
            sources.remember([raw, decoded], 'url')
            is_id = re.search(r'\d{3,}', decoded) or UUID.fullmatch(decoded) or has_email(decoded)
            path.append('<id>' if is_id else '<token>')
    return '/'.join(path)


def url_details(url, sources):
    for value in (url.username, url.password):
        if value:
            sources.remember_secret(unquote(value, errors='strict'), 'url')
    if url.fragment:
        sources.remember(unquote(url.fragment, errors='strict'), 'url')
    path = path_template(decoded_path_parts(url.path), sources)
    return path, encoded_pairs(url.query, sources, strict=auth_path(url.path))


def remember_header_path(value, target, sources):
    if not value or value == '*':
        return
    if not value.startswith('/') or re.search(r'[\x00-\x20\x7f#]', value):
        raise InvalidInput
    path, _, query = value.partition('?')
    parts = decoded_path_parts(path)
    path_template(parts, sources)
    request_path, _, request_query = target.partition('?')
    same_path = target and [decoded for _, decoded in parts] == [
        decoded for _, decoded in decoded_path_parts(request_path)]
    # When :path differs, it can be the only copy of a sensitive parameter.
    strict = not same_path or query != request_query or auth_path(path)
    encoded_pairs(query, sources, strict=strict)
    if same_path:
        sources.header_occurrence(':path', value)


def remember_referer(value, sources):
    value = value.strip(' \t')
    if re.search(r'[\x00-\x20\x7f]', value):
        raise InvalidInput
    url = urlsplit(value)
    if url.scheme in URL_SCHEMES and not url.hostname:
        raise InvalidInput
    url_details(url, sources)


def url_shape(raw, include_host, sources):
    if re.search(r'[\x00-\x20\x7f]', raw):
        raise InvalidInput
    url = urlsplit(raw)
    if url.scheme not in URL_SCHEMES:
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
    sources.structural_occurrence(raw, 'url')
    if not allowed:
        sources.remember(host, 'url')
    target = url.path or '/'
    if url.query:
        target += '?' + url.query
    path, pairs = url_details(url, sources)
    return authority if allowed else '<third-party>', path, pairs, authority, target


def remember_cookie(value, sources):
    name, sep, content = value.strip().partition('=')
    if not sep or not name.strip():
        return 0
    sources.remember_secret(name.strip(), 'cookie')
    sources.remember_secret(content.strip().strip('"'), 'cookie')
    return 1


def mime_header(value, header, sources):
    if '\r' in value or '\n' in value:
        raise InvalidInput
    message = Message(policy=policy.compat32)
    message[header] = value
    for _, parameter in message.get_params(header=header, failobj=[])[1:]:
        sources.remember(collapse_rfc2231_value(parameter, errors='strict'), 'mime-parameter')
    # The email parser cannot distinguish bare fragments from explicit empty values.
    for match in MIME_PARAMETER.finditer(value):
        fragment = match[1]
        if '=' not in fragment:
            remember_text(fragment, sources, kind='mime-parameter')
    return message


def header_shape(side, sources, *, response=False, authority='', target='', method='', strict=False):
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
        if (name == 'content-type' and mime_type(value)) or (
                not response and name == 'accept' and accept_type(value)):
            sources.header_occurrence(name, value)
            if name == 'content-type' and ';' in value:
                mime_header(value, 'Content-Type', sources)
        elif name in ('authorization', 'proxy-authorization'):
            credentials = value.split(maxsplit=1)
            if credentials:
                sources.remember_secret(credentials[-1], 'header-value')
        elif secret_field(original) and name not in ('cookie', 'set-cookie'):
            sources.remember_secret(value.strip(), 'header-value')
        elif strict and name.startswith('x-'):
            sources.remember_secret(value.strip(), 'header-value')
        if not response and name == 'referer':
            remember_referer(value, sources)
        if not response and name == ':path':
            remember_header_path(value, target, sources)
        elif name in origin_headers and bank_origin(value):
            sources.header_occurrence(name, value)
        elif not response and authority and (
                (name in ('host', ':authority') and value.lower() == authority.split('://')[1])
                or (name in ('origin', 'referer') and value.lower() == authority)
                or (name == ':method' and value == method and method in METHODS)
                or (name == ':scheme' and value == authority.partition('://')[0])):
            sources.header_occurrence(name, value)
        if name != ('set-cookie' if response else 'cookie'):
            # Check both spellings because the output normalizes header names.
            shaped = name_shape(original, 'headers')
            shaped = name_shape(name, 'headers') if shaped == original else shaped
            if shaped in KEY_TEMPLATES:
                sources.remember(original, 'header-name')
            names.add(shaped)
    cookies = require(side.get('cookies', []), list)
    for cookie in cookies:
        cookie = require(cookie, dict)
        sources.remember_secret(require(cookie['name'], str), 'cookie')
        sources.remember_secret(require(cookie['value'], str), 'cookie')
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


def remember_multipart_payload(part, sources, strict):
    sources.remember(part.get_filename(), 'mime-parameter')
    if part.is_multipart():
        for child in part.iter_parts():
            remember_multipart_payload(child, sources, strict)
    else:
        payload = part.get_payload(decode=True)
        if payload:
            if is_json_mime(part.get_content_type()) and payload.strip():
                remember_json_values(parse_json(payload), sources, strict=strict)
            else:
                remember_opaque_text(payload.decode('utf-8', errors='replace'), sources, strict=strict)
    if part.defects:
        raise InvalidInput


def multipart_names(text, raw_mime, sources, strict):
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
        remember_multipart_payload(part, sources, strict or secret_field(name))
    return names


def is_json_mime(mime):
    return mime == 'application/json' or mime.endswith('+json')


def request_body(request, headers, sources, *, strict):
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
    declared = declared_pairs(post.get('params', []), sources, 'form-value', strict=strict)
    if mime == FORM:
        pairs = encoded_pairs(text, sources, from_post=True, strict=strict) if text else declared
        body = pair_shape(pairs, sources)
    elif is_json_mime(mime):
        body = parsed_json_shape(text, sources, strict=strict)
    elif mime == MULTIPART:
        names = multipart_names(text, raw_mime, sources, strict) if text else [name for name, _ in declared]
        body = shaped_names(((name, None) for name in sorted(names)), sources)
    else:
        remember_opaque_text(text, sources, strict=strict)
        size = require(request.get('bodySize', -1), int)
        if size < 0 and text:
            size = len(text.encode('utf-8'))
        body = f'<body:{mime or "unknown"}:{bucket(size, SIZE_BOUNDS)}>'
    return {'mime': mime or '<omitted>', 'body': body}


def remember_json_values(data, sources, *, strict=False):
    pending = [(data, strict)]
    while pending:
        value, strict = pending.pop()
        if isinstance(value, dict):
            for name, child in value.items():
                if not name.startswith('_') and not PATH.fullmatch(name) and name_shape(name) in KEY_TEMPLATES:
                    sources.remember(name, 'templated-name')
                pending.append((child, strict or secret_field(name)))
        elif isinstance(value, list):
            pending.extend((child, strict) for child in value)
        elif strict and (isinstance(value, str) or type(value) in (int, float)):
            sources.remember_secret(str(value).strip(), 'json-scalar')
        else:
            sources.remember(value, 'json-scalar', selective=True)


def parsed_json_shape(text, sources, *, strict=False):
    if not text:
        return '<omitted>'
    data = parse_json(text)
    remember_json_values(data, sources, strict=strict)
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


def remember_tokens(text, sources, kind):
    for match in TOKEN.finditer(text):
        sources.remember(match[0], kind)


def remember_web_tokens(text, sources, kind, web_mime):
    end = 0
    for match in WEB_LITERAL.finditer(text):
        remember_tokens(text[end:match.start()], sources, kind)
        quoted = match['quoted']
        if quoted:
            literal = quoted[1:-1]
            if not web_structure(text, match, literal, sources, web_mime):
                sources.remember(literal, kind)
                remember_tokens(literal, sources, kind)
        else:
            remember_tokens(match[0], sources, kind)
        end = match.end()
    remember_tokens(text[end:], sources, kind)


def remember_text(text, sources, *, kind='body-token', selective=False, strict=False, web_mime=None):
    sources.remember(text, kind, selective=selective)
    sources.remember(text.splitlines(), kind, selective=selective)
    if web_mime is not None:
        remember_web_tokens(text, sources, kind, web_mime)
        return
    for match in TOKEN.finditer(text):
        if strict:
            sources.remember_secret(match[0], kind)
        else:
            sources.remember(match[0], kind, selective=selective)


def remember_opaque_text(text, sources, *, strict=False):
    if text.lstrip().startswith(('{', '[')):
        try:
            data = parse_json(text)
        except ValueError:
            pass
        else:
            remember_json_values(data, sources, strict=strict)
            return
    remember_text(text, sources, selective=not strict, strict=strict)


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
                remember_json_values(parse_json(data), self.sources, strict=True)
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


class AssetCredentialMarkup(HTMLParser):
    def __init__(self, sources):
        super().__init__()
        self.sources = sources

    def handle_starttag(self, _tag, attrs):
        values = dict(attrs)
        for key, value in attrs:
            if value and secret_field(key):
                remember_asset_secret(value, self.sources)
        if any(secret_field(values.get(key) or '') for key in ('name', 'id', 'property')):
            for key in ('value', 'content'):
                if values.get(key):
                    remember_asset_secret(values[key], self.sources)


def decode_asset_escapes(text):
    return ASSET_ESCAPE.sub(lambda m: m[3] or chr(int(m[1] or m[2], 16)), text)


def remember_asset_secret(value, sources):
    sources.remember_secret(value, 'body-token')
    auth = re.fullmatch(r'(?:Bearer|Basic)\s+(\S+)\s*', value, re.I)
    if auth:
        sources.remember_secret(auth[1], 'body-token')


def asset_credentials(text, sources, *, markup=False):
    # Scan credential values without collecting whole bundle lines or protocol literals.
    for match in ASSET_FIELD.finditer(text):
        name = match['name'].strip('"\'`')
        name = decode_asset_escapes(name)
        if secret_field(name):
            literal = match['value']
            value = literal if literal.isdecimal() else literal[1:-1]
            decoded = decode_asset_escapes(value)
            before = text[max(0, match.start() - 4096):match.start()]
            if decoded.lower() in ASSET_HEADER_LITERALS and ASSET_HEADER_REGISTRY.search(before):
                continue
            remember_asset_secret(value, sources)
            if decoded != value:
                remember_asset_secret(decoded, sources)
    for match in ASSET_TOKEN.finditer(text):
        value = match[0]
        if (len(value) >= 8 and not (PATH.fullmatch(value) or MIME.fullmatch(value.lower())
                                    or structured_origin(value.lower()))
                and (DIGITS.search(value) or JWT.search(value) or has_email(value) or PRIVATE_VALUE.search(value)
                     or opaque_alphanumeric(value, 'name') or blob_like(value, 'name'))):
            sources.remember(value, 'body-token')
    if markup:
        parser = AssetCredentialMarkup(sources)
        parser.feed(text)
        parser.close()


def tag_shape(name, *, ofx=False):
    if ofx and name.upper() in OFX_VERSION_TAGS:
        return name
    if not TAG_NAME.fullmatch(name) or DIGIT.search(name) or any(suspect(name, 'body')):
        return TAG_TEMPLATE
    return name


def shape_tag(name, sources, *, ofx=False):
    shaped = tag_shape(name, ofx=ofx)
    if shaped == TAG_TEMPLATE:
        sources.remember(name, 'templated-name')
    return shaped


def xml_tags(text, sources):
    tags = {}
    parser = expat.ParserCreate()
    parser.buffer_text = True

    def start_tag(name, attrs):
        tags[name] = None
        for value in attrs.values():
            sources.remember(value, 'body-token')

    def reject_doctype(*_args):
        raise InvalidInput

    parser.StartElementHandler = start_tag
    parser.StartDoctypeDeclHandler = reject_doctype
    parser.CharacterDataHandler = lambda value: remember_text(value, sources)
    parser.CommentHandler = lambda value: remember_text(value, sources)
    parser.ProcessingInstructionHandler = lambda _, value: remember_text(value, sources)
    parser.Parse(text, True)
    ofx = (next(iter(tags), '')).upper() == 'OFX'
    return list(dict.fromkeys(shape_tag(name, sources, ofx=ofx) for name in tags))


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
            name = match['tag']
            tags.setdefault(shape_tag(name, sources, ofx=True), None)
        elif not match['tag']:
            remember_text(match['comment'] or match['cdata'] or '', sources)
        end = match.end()
    tail = document[end:]
    if '<' in tail or (next(iter(tags), '')).upper() != 'OFX':
        raise InvalidInput
    remember_text(tail, sources)
    return list(dict.fromkeys(name.upper() if name != TAG_TEMPLATE else name for name in tags))


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


def static_response(mime, resource, request_path):
    if mime in STATIC_TEXT_MIMES or mime in STATIC_BINARY_MIMES or mime.startswith(STATIC_BINARY_PREFIXES):
        return True
    if mime in OFX_MIMES or mime in ('text/xml', 'application/xml') or mime.endswith('+xml'):
        return False
    if request_path.lower().endswith('.map'):
        return True
    # A HAR may label a narrowly typed API response as an image or script. Keep
    # scanning explicit JSON and download formats unless this is a source map.
    return isinstance(resource, str) and resource.lower() in STATIC_RESOURCES and not is_json_mime(mime)


def response_shape(response, sources, *, resource, request_path, strict):
    result, headers = header_shape(response, sources, response=True, strict=strict)
    redirect = response.get('redirectURL')
    if (isinstance(redirect, str) and bank_origin(redirect)
            and any(redirect.strip().casefold() == value.strip().casefold()
                    for value in headers.get('location', ()))):
        sources.structural_occurrence(redirect)
    content = require(response.get('content', {}), dict)
    declared_mime = require(content.get('mimeType', ''), str)
    mime = mime_type(declared_mime) or mime_type(first_header(headers, 'content-type'))
    for value in headers.get('accept', ()):
        if mime and accept_type(value) == mime:
            sources.header_occurrence('accept', value)
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
    is_xml = (mime in ('text/xml', 'application/xml') or mime.endswith('+xml')) and mime not in HTML_MIMES
    qfx_filename = extension in ('.ofx', '.qfx')
    if not qfx_filename and static_response(mime, resource, request_path):
        binary = mime not in STATIC_TEXT_MIMES and (
            mime in STATIC_BINARY_MIMES or mime.startswith(STATIC_BINARY_PREFIXES))
        if text and not binary:
            value = (base64.b64decode(text, validate=True).decode('utf-8', errors='replace')
                     if encoding == 'base64' else text)
            if is_json:
                remember_json_values(parse_json(value), sources, strict=strict)
            else:
                asset_credentials(value, sources, markup=mime in HTML_MIMES or value.lstrip().startswith('<'))
        if not strict or mime == 'image/svg+xml':
            text = ''
    if text and encoding == 'base64':
        sources.remember(text, 'body-text')
    possible_ofx = mime in DOWNLOAD_MIMES or qfx_filename
    declared_ofx = mime in OFX_MIMES or (qfx_filename and mime in DOWNLOAD_MIMES)
    if text and (is_json or is_xml or declared_ofx or possible_ofx):
        if encoding not in ('', 'base64'):
            raise InvalidInput
        decoded = base64.b64decode(text, validate=True) if encoding == 'base64' else text.encode('utf-8')
        if is_json:
            body = parsed_json_shape(decoded, sources, strict=strict)
        elif is_xml:
            body = xml_tags(decoded if encoding else text, sources)
        else:
            start = decoded.removeprefix(b'\xef\xbb\xbf').lstrip()
            if start.startswith(b'<?xml'):
                tags = xml_tags(decoded if encoding else text, sources)
                if tags and tags[0].upper() == 'OFX':
                    body = tags
                elif declared_ofx:
                    raise InvalidInput
            elif declared_ofx or OFX_START.match(start):
                body = ofx_tags(decoded, sources)
            else:
                remember_opaque_text(decoded.decode('utf-8', errors='replace'), sources, strict=strict)
    elif text:
        if encoding == 'base64' and not mime.startswith(('audio/', 'font/', 'image/', 'video/')):
            text = base64.b64decode(text, validate=True).decode('utf-8', errors='replace')
        if mime in HTML_MIMES:
            parser = HtmlValues(sources)
            parser.feed(text)
            parser.close()
        elif mime in WEB_MIMES:
            remember_text(text, sources, web_mime=mime)
        else:
            remember_opaque_text(text, sources, strict=strict)
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


def chrome_initiator_urls(initiator):
    if not isinstance(initiator, dict):
        return
    yield initiator.get('url')
    stack = initiator.get('stack')
    while isinstance(stack, dict):
        frames = stack.get('callFrames')
        if isinstance(frames, list):
            for frame in frames:
                if isinstance(frame, dict):
                    yield frame.get('url')
        stack = stack.get('parent')


def exclude_browser_metadata(entry, sources):
    for key, values in BROWSER_METADATA_ENUMS.items():
        value = entry.get(key)
        if isinstance(value, str) and value.casefold() in values:
            sources.structural_occurrence(value)
    for value in chrome_initiator_urls(entry.get('_initiator')):
        if isinstance(value, str) and bank_origin(value):
            sources.structural_occurrence(value)


def cors_names(value):
    names = {name.strip(' \t').lower() for name in value.split(',')}
    return names if all(HTTP_TOKEN.fullmatch(name) for name in names) else set()


def cors_origin(url):
    try:
        host = url.hostname
        if not host or url.scheme not in ('http', 'https'):
            return None
        port = url.port
        if port is None:
            port = 443 if url.scheme == 'https' else 80
        host = f'[{IPv6Address(host)}]' if ':' in host and '%' not in host else host.removesuffix('.')
        if structured_origin(f'{url.scheme}://{host}'):
            return url.scheme, host, port
    except ValueError:
        return None


def cors_header_origin(value):
    scheme, _, authority = value.partition('://')
    if scheme not in ('http', 'https') or not authority or re.search(r'[\x00-\x20\x7f/?#@]', authority):
        return None
    try:
        return cors_origin(urlsplit(value))
    except ValueError:
        return None


def exclude_cors_header_mirrors(entries, outlines, starts, sources):
    later_requests = defaultdict(set)
    for started, entry, outline in sorted(zip(starts, entries, outlines), key=lambda row: row[0], reverse=True):
        header_values = defaultdict(list)
        for side in ('request', 'response'):
            for header in entry[side].get('headers', []):
                header_values[side, header['name'].lower()].append(header['value'])
        request_names = frozenset(outline['request']['headers'])
        retained = {'request': request_names, 'response': set(outline['response']['headers'])}
        for side, list_header, mirrored_side in CORS_HEADER_LISTS:
            for value in header_values[side, list_header]:
                names = cors_names(value)
                if names and names <= retained[mirrored_side]:
                    sources.header_occurrence(list_header, value)

        origins = header_values['request', 'origin']
        method = outline['method']
        raw_url = entry['request']['url']
        origin = cors_header_origin(origins[0]) if len(origins) == 1 else None
        if not origin:
            continue
        target = (raw_url, origin)
        if method in METHODS and method != 'OPTIONS':
            later_requests[(*target, method)].add((started, request_names))
            continue
        if method != 'OPTIONS' or not 200 <= outline['response']['status'] < 300:
            continue
        request_origin = cors_origin(urlsplit(raw_url))
        if not request_origin or origin == request_origin:
            continue
        methods = header_values['request', 'access-control-request-method']
        declared = header_values['request', 'access-control-request-headers']
        allowed = header_values['response', 'access-control-allow-headers']
        allow_origins = header_values['response', 'access-control-allow-origin']
        if len(methods) != 1 or len(declared) != 1 or len(allowed) != 1 or len(allow_origins) != 1:
            continue
        if allow_origins[0] != '*' and cors_header_origin(allow_origins[0]) != origin:
            continue
        declared_names = cors_names(declared[0])
        allowed_names = cors_names(allowed[0])
        candidates = later_requests.get((*target, methods[0]), ())
        if (declared_names and declared_names <= allowed_names <= CORS_PREFLIGHT_NAMES
                and any(later > started and allowed_names <= names for later, names in candidates)):
            for list_header, value, names in (
                    ('access-control-request-headers', declared[0], declared_names),
                    ('access-control-allow-headers', allowed[0], allowed_names)):
                if not names <= request_names:
                    sources.header_occurrence(list_header, value)


def make_skeleton(document, include_host, sources):
    log = require(require(document, dict)['log'], dict)
    entries = require(log['entries'], list)
    output = []
    starts = []
    counts = Counter()
    first = None
    for index, entry in enumerate(entries):
        entry = require(entry, dict)
        exclude_browser_metadata(entry, sources)
        started = har_start(entry['startedDateTime'])
        starts.append(started)
        if first is None:
            first = started
        request = require(entry['request'], dict)
        method = require(request['method'], str)
        if not HTTP_TOKEN.fullmatch(method):
            raise InvalidInput
        raw_url = require(request['url'], str)
        origin, path, pairs, authority, target = url_shape(raw_url, include_host, sources)
        request_path = urlsplit(raw_url).path
        strict = auth_path(request_path)
        declared = declared_pairs(request.get('queryString', []), sources, 'query-value', strict=strict)
        request_info, headers = header_shape(request, sources, authority=authority, target=target, method=method,
                                             strict=strict)
        content_type = mime_type(first_header(headers, 'content-type'))
        accept = accept_type(first_header(headers, 'accept'))
        if content_type:
            request_info['content_type'] = content_type
        if accept:
            request_info['accept'] = accept
        request_info.update(request_body(request, headers, sources, strict=strict))
        response = response_shape(require(entry['response'], dict), sources, request_path=request_path,
                                  resource=entry.get('_resourceType'), strict=strict)
        duration = entry.get('time', -1)
        if type(duration) not in (int, float):
            raise InvalidInput
        outline = {'index': index, 'relative_seconds': round((started - first).total_seconds()),
                   'duration_ms_bucket': bucket(duration, DURATION_BOUNDS),
                   'method': method if method in METHODS else '<method>',
                   'origin': origin, 'path': path, 'query': pair_shape(pairs or declared, sources),
                   'request': request_info, 'response': response}
        output.append(outline)
        counts[path] += 1
    exclude_cors_header_mirrors(entries, output, starts, sources)
    return {'entries': output, 'path_counts': [{'path': path, 'count': count}
                                               for path, count in sorted(counts.items())]}


def field_kind(field, location):
    if field == 'headers':
        return 'request.header-name' if '.request.headers[' in location else 'response.header-name'
    if field == 'name':
        if '.query[' in location:
            return 'query-name'
        return 'json-key' if '.fields[' in location else 'form-name'
    if field == 'path':
        return 'path_counts.path' if location.startswith('$.path_counts[') else 'path'
    if field in ('mime', 'accept', 'content_type'):
        return 'mime'
    if field in SAFE_BUCKETS or field == 'type':
        return 'placeholder'
    return field if field in ('body', 'origin', 'disposition', 'method') else 'other'


SHAPE_BOUNDS = (4, 8, 16, 32, 64, 128, 256, 1024)
CHARACTER_CLASSES = (
    ('lower', re.compile(r'[a-z]')),
    ('upper', re.compile(r'[A-Z]')),
    ('digit', re.compile(r'[0-9]')),
    ('hyphen', re.compile(r'-')),
    ('underscore', re.compile(r'_')),
    ('dot', re.compile(r'\.')),
    ('slash', re.compile(r'/')),
    ('space', re.compile(r' ')),
    ('control', re.compile(r'[\x00-\x1f\x7f]')),
    ('symbol', re.compile(r'[\x21-\x2c\x3a-\x40\x5b-\x5e\x60\x7b-\x7e]')),
)


def describe_shape(value):
    if not isinstance(value, str):
        return {'length_bucket': None, 'classes': ['non-string']}
    low = 0
    for high in SHAPE_BOUNDS:
        if len(value) <= high:
            length_bucket = f'{low}-{high}'
            break
        low = high + 1
    else:
        length_bucket = f'{low}+'
    classes = [label for label, pattern in CHARACTER_CLASSES if pattern.search(value)]
    if not value.isascii():
        classes.append('non-ascii')
    return {'length_bucket': length_bucket, 'classes': classes}


class Diagnostics:
    def __init__(self):
        self.buckets = {}

    def record(self, rule, kind, location, value, source_kinds):
        key = rule, kind
        if key not in self.buckets:
            self.buckets[key] = {'rule': rule, 'field_kind': kind, 'count': 0, 'examples': []}
            if rule == 'copied-input-value':
                self.buckets[key]['source_kinds'] = Counter()
        bucket = self.buckets[key]
        bucket['count'] += 1
        if source_kinds:
            bucket['source_kinds'].update(source_kinds)
        if len(bucket['examples']) < 5:
            bucket['examples'].append({'field_path': location, 'shape': describe_shape(value)})

    def render(self, entry_count, offender_count):
        return json.dumps({
            'tool_version': VERSION,
            'python_version': '.'.join(map(str, sys.version_info[:3])),
            'status': 'complete' if offender_count is not None else 'processing-failed',
            'entry_count': entry_count,
            'offender_count': offender_count,
            'buckets': [self.buckets[key] for key in sorted(self.buckets)],
        }, indent=2, sort_keys=True) + '\n'


def suspect(value, field):
    """Yield the pattern rules triggered by the candidate."""
    if not value.isascii() or re.search(r'[\x00-\x1f\x7f]', value):
        yield 'non-ascii-or-control'
    if has_email(value):
        yield 'email'
    for rule, pattern in (('digit-run', DIGITS), ('amount', MONEY), ('jwt', JWT)):
        if pattern.search(value):
            yield rule
    if DATE.search(value) or TEXT_DATE.search(value):
        yield 'date'
    if opaque_alphanumeric(value, field):
        yield 'opaque-alphanumeric'
    if blob_like(value, field):
        yield 'base64-like'


def self_check(output, sources, diagnostics=None):
    forbidden = sources.forbidden_prefixes()
    offenders = set()

    def record(rule, location, field, value, kinds=(), kind_hint=None):
        offenders.add(location)
        if diagnostics is not None:
            diagnostics.record(rule, kind_hint or field_kind(field, location), location, value, kinds)

    def check(value, location, field, *, valid=True, scanned=None, kind_hint=None):
        if not valid:
            record('invalid-structure', location, field, value, kind_hint=kind_hint)
            if diagnostics is None:
                return
        for rule, kinds in matched_rules(value if scanned is None else scanned, field):
            record(rule, location, field, value, kinds, kind_hint)
            if diagnostics is None:
                break

    def scan(value, location, field, kind_hint=None):
        if isinstance(value, dict):
            for index, (key, child) in enumerate(value.items()):
                if key in FIXED_FIELDS:
                    scan(child, f'{location}.{key}', key)
                else:
                    check(key, f'{location}.key[{index}]', '', kind_hint='object-key')
                    scan(child, f'{location}.value[{index}]', '')
        elif isinstance(value, list):
            if location.endswith('.response.body') and value and isinstance(value[0], str):
                kind_hint = 'ofx-tag' if value[0].upper() == 'OFX' else 'xml-tag'
            for index, item in enumerate(value):
                scan(item, f'{location}[{index}]', field, kind_hint)
        elif isinstance(value, str):
            if value in GENERATED_STRINGS.get(field, ()):
                return
            if field == 'body' and value.startswith('<body:') and value.endswith('>'):
                mime, _, size = value[6:-1].rpartition(':')
                if size in SAFE_BUCKETS['size_bucket']:
                    if mime == 'unknown':
                        return
                    if MIME.fullmatch(mime):
                        check(value, location, 'mime', scanned=mime, kind_hint='placeholder')
                        return
            scanned = value
            valid = field not in ('name', 'headers') or name_ok(value, field)
            if field == 'path':
                valid = bool(PATH.fullmatch(value))
            elif kind_hint in ('ofx-tag', 'xml-tag'):
                valid = tag_shape(value, ofx=kind_hint == 'ofx-tag') == value
            elif field == 'disposition' and (match := DISPOSITION.fullmatch(value)):
                scanned = match[1]
            check(value, location, field, valid=valid, scanned=scanned, kind_hint=kind_hint)
        elif type(value) is not int or not NUMERIC_LOCATIONS.fullmatch(location):
            record('invalid-structure', location, field, value, kind_hint=kind_hint)

    def matched_rules(value, field):
        for rule in suspect(value, field):
            yield rule, ()
        matches = copied_values(value, field)
        if diagnostics is None:
            if next(matches, None) is not None:
                yield 'copied-input-value', ()
        else:
            kinds = set()
            for source, short in set(matches):
                kinds.update(sources.source_kinds(source, short))
            if kinds:
                yield 'copied-input-value', kinds

    def copied_values(value, field):
        lowered = value.casefold()
        if sources.short_secrets:
            for source in matching_short_secrets(lowered, field, sources.short_secrets):
                yield source, True
        allowed_copies = ('/<token>',) if field == 'path' else ()
        for index in range(len(lowered) - 3):
            for source in forbidden.get(lowered[index:index + 4], ()):
                if source not in allowed_copies and lowered.startswith(source, index):
                    yield source, False

    scan(output, '$', '')
    return sorted(offenders)


def matching_short_secrets(value, field, secrets):
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
        return set()
    return secrets.intersection(atoms)


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


def structured_origin(value):
    scheme, _, host = value.partition('://')
    if scheme not in URL_SCHEMES:
        return False
    if host.startswith('[') and host.endswith(']'):
        try:
            return '%' not in host and bool(IPv6Address(host[1:-1]))
        except ValueError:
            return False
    return len(host) <= 253 and all(HOST.fullmatch(label) for label in host.split('.'))


def canonical_base64(value):
    standard = value.replace('-', '+').replace('_', '/')
    try:
        decoded = base64.b64decode(standard + '=' * (-len(standard) % 4), validate=True)
    except ValueError:
        return False
    return base64.b64encode(decoded).decode('ascii').rstrip('=') == standard


def canonical_blob(candidate):
    plain = candidate.rstrip('=')
    if (plain != candidate or '-' in plain or '_' in plain) and canonical_base64(plain):
        return True
    # A header prefix can mask a canonical token containing a URL-safe separator.
    for separator in re.finditer(r'[-_]', plain):
        suffix = plain[separator.end():]
        if len(suffix) < 16:
            break
        if ('-' in suffix or '_' in suffix) and canonical_base64(suffix):
            return True
    # A header name can prepend a label to a 128- or 256-bit token.
    for width in (22, 43):
        if len(plain) == width or (len(plain) > width and plain[-width - 1] in '-_'):
            token = plain[-width:]
            if re.search(r'[a-z]', token) and re.search(r'[A-Z]', token) and canonical_base64(token):
                return True
    return False


def opaque_alphanumeric(value, field):
    # DNS and MIME tokens can include ordinary vendor versions in lowercase.
    structured = ((field == 'origin' and structured_origin(value))
                  or (field in ('accept', 'content_type', 'mime') and MIME.fullmatch(value)))
    minimum_groups = 3 if structured else 1
    return any(len(EMBEDDED_DIGITS.findall(candidate)) >= minimum_groups and not name_word(candidate)
               for candidate in LONG_ALNUM.findall(value))


def blob_like(value, field):
    if HEX_BLOB.search(value):
        return True
    if ((field == 'origin' and structured_origin(value))
            or (field in ('accept', 'content_type', 'mime') and MIME.fullmatch(value))):
        return False
    if field == 'path':
        # Keep adjacent token-like segments together because slash is a base64 character.
        value = '/'.join('.' if name_word(part) and not HEX_BLOB.search(part) else part
                         for part in value.split('/'))
        pieces = value.split('.')
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
            if structural and all(name_word(part) for part in re.split(r'[-_]', candidate)):
                continue
            mixed_case = re.search(r'[a-z]', candidate) and re.search(r'[A-Z]', candidate)
            if (canonical_blob(candidate) or (mixed_case and
                    (re.search(r'[0-9]', candidate) or (field == 'path' and '/' in candidate)))):
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
    parser.add_argument('--diagnose', action='store_true',
                        help='print a position-only diagnostic report and exit nonzero')
    try:
        args = parser.parse_args()
        if (args.force and args.o is None) or (args.diagnose and args.o is not None):
            raise InvalidArguments
        include_host = re.compile(args.include_host_pattern, re.ASCII) if args.include_host_pattern else None
    except (InvalidArguments, re.error, OverflowError, RecursionError):
        print('Invalid arguments. See --help.', file=sys.stderr)
        return 2
    diagnostics = Diagnostics() if args.diagnose else None
    entry_count = None
    try:
        # Keep parser warning text local while preserving warnings-as-errors behavior.
        with warnings.catch_warnings(record=True) if args.diagnose else nullcontext():
            document = parse_json(args.input.read_text(encoding='utf-8-sig'))
            if args.diagnose:
                log = require(require(document, dict)['log'], dict)
                entry_count = len(require(log['entries'], list))
            sources = InputValues(document, diagnose=args.diagnose)
            outline = make_skeleton(document, include_host, sources)
            offenders = self_check(outline, sources, diagnostics)
        if args.diagnose:
            payload = diagnostics.render(entry_count, len(offenders))
        elif offenders:
            print('\n'.join(offenders), file=sys.stderr)
            return 1
        else:
            payload = json.dumps(outline, indent=2, ensure_ascii=True) + '\n'
    except (Exception, KeyboardInterrupt):
        if not args.diagnose:
            print('Could not read or process the HAR.', file=sys.stderr)
            return 1
        payload = Diagnostics().render(entry_count, None)
    try:
        if args.diagnose or args.o is None:
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
    return 1 if args.diagnose else 0


if __name__ == '__main__':
    sys.exit(main())
