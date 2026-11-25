"""Synthetic, offline coverage of the HAR skeleton command."""

import base64
from contextlib import redirect_stderr, redirect_stdout
import copy
import itertools
from io import StringIO
import json
import os
from pathlib import Path
import runpy
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import quote, urlsplit


SCRIPT = Path(__file__).resolve().parents[2] / 'tools' / 'har_skeleton.py'
ACCOUNT = '000012345678'
OTHER_ACCOUNT = '000098765432'
EMAIL = 'fake-payee@example.test'
JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.dGhpcy1pcy1ub3QtYS1zaWduYXR1cmU'
COOKIE = 'syntheticSessionValue'
DEVICE = 'synthetic-device-key'
ACCOUNT_LABEL = 'Made Up Checking'
TXN_LABEL = 'Fictional Merchant'
FILE_NAME = 'synthetic-checking.qfx'
DATES = ('2026-08-15', '2026-09-30')
THIRD_HOST = 'assets.example.test'
QFX = f'''OFXHEADER:100
DATA:OFXSGML
VERSION:102
ENCODING:USASCII

<OFX>
<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0</STATUS></SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1><STMTTRNRS><STMTRS>
<BANKACCTFROM><BANKID>000011110<ACCTID>{ACCOUNT}</BANKACCTFROM>
<BANKTRANLIST><STMTTRN><DTPOSTED>20260915000000<TRNAMT>-48.56
<FITID>fake-ledger-entry<NAME>{TXN_LABEL}</STMTTRN>
<STMTTRN><DTPOSTED>20260916000000<TRNAMT>17.25<FITID>fake-ledger-entry-two</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>'''
TAGS = ['OFX', 'SIGNONMSGSRSV1', 'SONRS', 'STATUS', 'CODE', 'BANKMSGSRSV1',
        'STMTTRNRS', 'STMTRS', 'BANKACCTFROM', 'BANKID', 'ACCTID', 'BANKTRANLIST',
        'STMTTRN', 'DTPOSTED', 'TRNAMT', 'FITID', 'NAME']


def header(name, value):
    return {'name': name, 'value': value}


def entry(url, *, seconds='00', method='GET', mime='application/json', text='',
          request_headers=(), response_headers=(), post=None):
    request = {'method': method, 'url': url, 'httpVersion': 'h2', 'headersSize': -1,
               'headers': list(request_headers), 'queryString': [], 'cookies': [], 'bodySize': -1}
    if post is not None:
        request['postData'] = post
    return {'startedDateTime': f'2026-10-01T12:00:{seconds}+00:00', 'time': 136.2,
            'request': request, 'response': {'status': 200, 'statusText': 'OK',
                        'headers': [header('Content-Type', mime), *response_headers],
                        'content': {'mimeType': mime, 'size': len(text), 'text': text},
                        'cookies': [], 'bodySize': len(text)},
            'serverIPAddress': '192.0.2.150', 'connection': 'hiddenConnection',
            'timings': {'wait': 121.7}, '_initiator': {'url': 'https://hidden.example.test/'}}


def synthetic_har():
    accounts = entry('https://secure.chase.com/api/accounts', request_headers=[
        header(':authority', 'secure.chase.com'), header('Accept', 'application/json'),
        header('Cookie', f'fictionalSession={COOKIE}; fictionalPreference=pretend'),
        header('Authorization', f'Bearer {JWT}'), header('X-Device-Token', DEVICE),
    ], text=json.dumps({'accounts': [
        {'accountNumber': ACCOUNT, 'balance': 765.43, 'label': ACCOUNT_LABEL,
         'profile': {'email': EMAIL, 'active': True}},
        {'accountNumber': OTHER_ACCOUNT, 'balance': 245.67, 'label': 'Made Up Card'},
    ]}))
    url = f'https://secure.chase.com/activity/{ACCOUNT}/download?toDate={DATES[1]}&fromDate={DATES[0]}'
    download = entry(url, seconds='01.600', method='POST', mime='application/vnd.intu.qfx', text=QFX,
                     request_headers=[header('Origin', 'https://secure.chase.com'),
                                      header('Content-Type', 'application/x-www-form-urlencoded'),
                                      header('Accept', 'application/vnd.intu.qfx')],
                     response_headers=[header('Content-Disposition', f'attachment; filename="{FILE_NAME}"'),
                                       header('Set-Cookie', 'fictionalName=fake-refresh; Expires=Wed, 15 Jun 2033 00:00:00 GMT'),
                                       header('Set-Cookie', 'otherName=fake-state; Secure')],
                     post={'mimeType': 'application/x-www-form-urlencoded',
                           'text': f'accountId={ACCOUNT}&format=QFX&remember=false'})
    download['request']['queryString'] = [header('toDate', DATES[1]), header('fromDate', DATES[0])]
    asset = entry(f'https://{THIRD_HOST}/scripts/metrics', seconds='02.201',
                  mime='application/javascript', text='const ignored = "synthetic script body";')
    return {'log': {'version': '1.2', 'creator': {'name': 'Fake Browser', 'version': '1'},
                    'pages': [{'title': f'{ACCOUNT_LABEL} — {ACCOUNT}', 'id': 'fake-page'}],
                    'entries': [accounts, download, asset]}}


def synthetic_banking_har():
    capture = synthetic_har()
    accounts, download, _ = capture['log']['entries']
    accounts['request']['url'] = (
        'https://secure.chase.com/api/recentitems/accountview/transactionHistory'
        '?includeAccountDetails=true'
    )
    accounts['request']['headers'].extend([
        header('Sec-CH-UA-Platform', '"Imaginary OS"'),
        header('X-JPMC-CSRF-Token', 'pretendCrossSiteCredential'),
        header('X-Client-Request-Context', 'synthetic browser context'),
    ])
    accounts['response']['headers'].extend([
        header('Access-Control-Allow-Origin', 'https://secure.chase.com'),
        header('X-JPMC-Response-Context', 'synthetic response context'),
        header('X-Content-Type-Options', 'nosniff'),
        header('Cross-Origin-Resource-Policy', 'same-site'),
    ])
    accounts['response']['content']['text'] = json.dumps({
        'customerAccountSummary': {
            'availableAccountDetails': [
                {'accountIdentifier': f'{9000 + index:04d}',
                 'accountDisplayDescription': 'Fake account label',
                 'currentAvailableBalance': 123.45,
                 'preferencesAndSettings': {'electronicDeliveryEnabled': True}}
                for index in range(24)
            ],
        },
    })
    accounts['response']['content']['size'] = 65536
    download['request']['postData']['text'] += '&statementDownloadFormat=webconnect'
    analytics = entry('https://browser-telemetry.example.test/metrics/recentitems/session',
                      mime='application/javascript', text='let syntheticSession = "fake";')
    capture['log']['entries'] = [accounts, download, analytics]
    for _ in range(23):
        capture['log']['entries'].extend(copy.deepcopy([accounts, download, analytics]))
    capture['log']['entries'][-1]['startedDateTime'] = '2026-10-01T13:12:34Z'
    return capture


def chrome_http2_har():
    capture = synthetic_banking_har()
    accounts, download, analytics = capture['log']['entries'][:3]
    accounts['request']['url'] = ('https://asset.chase.com/svc/rr/accounts/secure/v1/activity/'
                                  f'{ACCOUNT}?includeAccountDetails=true')
    accounts['response']['headers'].extend([
        header('Access-Control-Expose-Headers', 'content-type'),
        header('X-Client-ResponseTimingPolicy', 'fake policy context'),
    ])
    beacon = entry('https://asset.chase.com/api/recent%69tems/stylesheet', method='POST',
                   mime='text/plain', text='synthetic acknowledgement',
                   response_headers=[header('Accept', 'text/plain')],
                   post={'mimeType': 'text/plain;charset=UTF-8', 'text': 'synthetic event payload'})
    beacon['request']['headers'].append(header('content-type', 'text/plain;charset=UTF-8'))
    page = entry('https://www.chase.com/', mime='text/html; charset=utf-8',
                 text='<html><main>Demo</main></html>')
    script = entry('https://static.chase.com/assets/scripts', mime='application/javascript',
                   text='const example = "synthetic literal";')
    templates = [accounts, download, analytics, beacon, page, script]
    for item, resource_type in zip(templates, ('xhr', 'fetch', 'script', 'ping', 'document', 'stylesheet')):
        request = item['request']
        url = urlsplit(request['url'])
        target = (url.path or '/') + ('?' + url.query if url.query else '')
        if item is beacon:
            target = '/api/recentitems/stylesheet'
        # Browser exports can keep both the serialized target and HAR's decoded structure.
        request['headers'] = [
            header(':authority', url.netloc), header(':method', request['method']),
            header(':path', target), header(':scheme', url.scheme),
            header('origin', 'https://www.chase.com'),
            header('referer', 'https://www.chase.com/portal?mode=sample'),
            header('sec-fetch-dest', 'empty'), header('sec-fetch-mode', 'cors'),
            header('sec-fetch-site', 'same-site'),
            *(item for item in request['headers'] if item['name'] not in
              (':authority', 'Origin')),
        ]
        item.update(_resourceType=resource_type, _priority='VeryHigh',
                    _initiator={'type': 'script', 'stack': {'callFrames': [
                        {'functionName': 'syntheticHandler', 'scriptId': '4',
                         'url': 'https://asset.chase.com', 'lineNumber': 4, 'columnNumber': 8},
                    ]}})
        item['response']['httpVersion'] = 'h2'
    capture['log']['entries'] = [copy.deepcopy(item) for _ in range(20) for item in templates]
    return capture


def bundle_config_har():
    origin = 'https://asset.chase.com'
    route = '/svc/config/accounts'
    header_name = 'x-client-context'
    mime = 'application/json'
    repeated_names = ['availableAccountDetails', 'configurationLabel', 'response-header-name']
    nested = {'pastDepthLimit': True}
    for i in range(9):
        nested = {f'level{i}': nested}
    config = {name: name for name in repeated_names}
    config.update({f'{route}/variant{i}': True for i in range(300)})
    config.update({'01234567': True, '09876543': None, 'v8ss5qb9km2zde6p': True,
                   EMAIL: True, 'nestedConfiguration': nested,
                   'wideConfiguration': dict.fromkeys(
                       (f'field{letters}' for letters in itertools.islice(
                           map(''.join, itertools.product('abcdefghijklmnopqrstuvwxyz', repeat=2)), 300)), True),
                   'publicOrigin': origin, 'publicRoute': route})
    bank = entry(origin + route, text=json.dumps(config),
                 request_headers=[header(header_name, 'example'), header('Accept', mime)])
    names = [header_name, 'content-type', mime, origin, route, *repeated_names]
    script = entry('https://static.chase.com/bundle', mime='application/javascript',
                   text='const protocolCatalog = ' + json.dumps(names * 1500) + ';')
    script['_resourceType'] = 'script'
    return {'log': {'entries': [script, bank]}}


class HarSkeletonTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.source = Path(self.directory.name) / 'synthetic.har'
        self.destination = Path(self.directory.name) / 'out.json'
        self.har = synthetic_har()

    def run_tool(self, *args, raw=None, python_flags=()):
        if isinstance(raw, bytes):
            self.source.write_bytes(raw)
        else:
            self.source.write_text(json.dumps(self.har) if raw is None else raw, encoding='utf-8')
        return subprocess.run([sys.executable, '-I', *python_flags, str(SCRIPT), str(self.source), *map(str, args)],
                              capture_output=True, text=True, timeout=10, check=False)

    def successful(self, result):
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, '')
        return json.loads(result.stdout)

    def test_synthetic_secrets_are_absent(self):
        result = self.run_tool()
        self.successful(result)
        for secret in (ACCOUNT, OTHER_ACCOUNT, EMAIL, JWT, COOKIE, DEVICE, FILE_NAME, THIRD_HOST,
                       *DATES, ACCOUNT_LABEL, TXN_LABEL, '765.43', '245.67', '48.56', '17.25',
                       'fictionalSession', 'fictionalPreference', 'fictionalName', 'fake-refresh',
                       'otherName', 'fake-state', '20260915000000', 'fake-ledger-entry',
                       '192.0.2.150', 'hiddenConnection', 'hidden.example.test', 'synthetic script body'):
            with self.subTest(secret=secret):
                self.assertNotIn(secret, result.stdout)

    def test_qfx_flow_retains_structure(self):
        outline = self.successful(self.run_tool())
        accounts, download, asset = outline['entries']
        self.assertEqual(download['index'], 1)
        self.assertEqual(download['relative_seconds'], 2)
        self.assertEqual(download['duration_ms_bucket'], 'le-1000')
        self.assertEqual(download['origin'], 'https://secure.chase.com')
        self.assertEqual(download['method'], 'POST')
        self.assertEqual(download['path'], '/activity/<id>/download')
        self.assertEqual(download['query'], [header_type('fromDate', '<date>'), header_type('toDate', '<date>')])
        self.assertEqual(download['request']['body'], [header_type('accountId', '<id>'),
                                                       header_type('format', '<str:le-8>'),
                                                       header_type('remember', '<bool>')])
        self.assertEqual(download['request']['content_type'], 'application/x-www-form-urlencoded')
        self.assertEqual(download['request']['accept'], 'application/vnd.intu.qfx')
        response = download['response']
        self.assertEqual(response['status'], 200)
        self.assertEqual(response['mime'], 'application/vnd.intu.qfx')
        self.assertEqual(response['size_bucket'], 'le-1024')
        self.assertEqual(response['disposition'], 'attachment; filename=<name>.qfx')
        self.assertEqual(response['body'], TAGS)
        self.assertEqual(response['set_cookie_count'], 2)
        self.assertEqual(response['headers'], ['content-disposition', 'content-type'])
        self.assertEqual(accounts['request']['cookie_count'], 2)
        self.assertIn('authorization', accounts['request']['headers'])
        self.assertNotIn('cookie', accounts['request']['headers'])
        array = accounts['response']['body']['fields'][0]['type']
        self.assertEqual(array['count_bucket'], 'le-5')
        self.assertEqual(array['first']['fields'][:2], [header_type('accountNumber', '<id>'),
                                                      header_type('balance', '<num>')])
        self.assertEqual(asset['response']['body'], '<omitted>')
        self.assertIn({'path': download['path'], 'count': 1}, outline['path_counts'])

    def test_banking_capture_retains_structure(self):
        self.har = synthetic_banking_har()
        outline = self.successful(self.run_tool())
        accounts, download, analytics = outline['entries'][:3]
        self.assertEqual(len(outline['entries']), 72)
        self.assertEqual(outline['entries'][-1]['relative_seconds'], 4354)
        self.assertEqual(accounts['origin'], 'https://secure.chase.com')
        self.assertEqual(analytics['origin'], '<third-party>')
        path = '/api/recentitems/accountview/<token>'
        self.assertEqual(accounts['path'], path)
        self.assertIn({'path': path, 'count': 24}, outline['path_counts'])
        self.assertIn('x-jpmc-response-context', accounts['response']['headers'])
        self.assertIn('x-jpmc-csrf-token', accounts['request']['headers'])
        self.assertIn('sec-ch-ua-platform', accounts['request']['headers'])
        self.assertEqual(accounts['request']['cookie_count'], 2)
        self.assertEqual(download['response']['set_cookie_count'], 2)
        self.assertEqual(accounts['query'], [header_type('includeAccountDetails', '<bool>')])
        self.assertIn(header_type('statementDownloadFormat', '<str:le-32>'), download['request']['body'])
        summary, = accounts['response']['body']['fields']
        self.assertEqual(summary['name'], 'customerAccountSummary')
        available, = summary['type']['fields']
        self.assertEqual(available['name'], 'availableAccountDetails')
        self.assertEqual(available['type']['count_bucket'], 'le-100')
        fields = available['type']['first']['fields']
        self.assertIn(header_type('accountIdentifier', '<int>'), fields)
        self.assertIn(header_type('accountDisplayDescription', '<str:le-32>'), fields)
        self.assertIn(header_type('preferencesAndSettings', {
            'fields': [header_type('electronicDeliveryEnabled', '<bool>')],
        }), fields)
        self.assertEqual(accounts['response']['size_bucket'], 'le-65536')
        self.assertEqual(download['response']['disposition'], 'attachment; filename=<name>.qfx')
        self.assertIn('BANKACCTFROM', download['response']['body'])
        self.assertIn('STMTTRN', download['response']['body'])

    def diagnose(self, **kwargs):
        result = self.run_tool('--diagnose', **kwargs)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, '')
        return result.stdout, json.loads(result.stdout)

    def test_public_http2_slots_pass_direct_self_check(self):
        module = runpy.run_path(str(SCRIPT))
        origins = ('https://asset.chase.com', 'https://regionalassetdelivery.chase.com')
        mimes = ('text/plain', 'application/json', 'text/html; charset=utf-8',
                 'application/vnd.chase.retailaccountconfiguration+json')
        path = '/svc/rr/accounts/secure/v1/activity/<id>'
        for mime in mimes:
            self.assertEqual(list(module['suspect'](mime, 'mime')), [])
        for field, values in (('origin', origins), ('mime', tuple(map(module['mime_type'], mimes))), ('path', (path,))):
            for value in values:
                with self.subTest(field=field, value=value):
                    self.assertEqual(list(module['suspect'](value, field)), [])
                    sources = module['InputValues']({})
                    self.assertEqual(module['self_check']({'entries': [{field: value}]}, sources), [])

    def test_chrome_http2_capture_preserves_public_structure(self):
        self.har = chrome_http2_har()
        outline = self.successful(self.run_tool())
        accounts, download, analytics, beacon, page, script = outline['entries'][:6]
        self.assertEqual(len(outline['entries']), 120)
        self.assertEqual([item['origin'] for item in (accounts, download, analytics, beacon, page, script)],
                         ['https://asset.chase.com', 'https://secure.chase.com', '<third-party>',
                          'https://asset.chase.com', 'https://www.chase.com', 'https://static.chase.com'])
        self.assertEqual(accounts['path'], '/svc/rr/accounts/secure/v1/activity/<id>')
        self.assertEqual(beacon['path'], '/api/recentitems/stylesheet')
        self.assertEqual([item['response']['mime'] for item in (accounts, beacon, page)],
                         ['application/json', 'text/plain', 'text/html'])
        self.assertEqual(beacon['request']['content_type'], 'text/plain')
        self.assertTrue({':authority', ':method', ':path', ':scheme', 'origin',
                         'referer', 'sec-fetch-site'}.issubset(accounts['request']['headers']))
        self.assertIn('x-client-responsetimingpolicy', accounts['response']['headers'])
        self.assertEqual(accounts['query'], [header_type('includeAccountDetails', '<bool>')])
        self.assertIn('BANKACCTFROM', download['response']['body'])

    def test_bundle_and_large_config_keep_bounded_public_shape(self):
        self.har = bundle_config_har()
        result = self.run_tool()
        outline = self.successful(result)
        script, config = outline['entries']
        self.assertEqual(script['response']['body'], '<omitted>')
        self.assertEqual(config['origin'], 'https://asset.chase.com')
        self.assertEqual(config['path'], '/svc/config/accounts')
        self.assertIn('x-client-context', config['request']['headers'])
        fields = {field['name']: field for field in config['response']['body']['fields']}
        for key in ('availableAccountDetails', 'configurationLabel', 'response-header-name',
                    '<key:route>', '<num-key>', '<key:opaque>', '<key:email>'):
            self.assertIn(key, fields)
        self.assertEqual(fields['<num-key>']['count_bucket'], 'le-5')
        self.assertEqual(fields['<key:route>']['count_bucket'], 'gt-100')
        wide = fields['wideConfiguration']['type']['fields']
        self.assertEqual(len(wide), 41)
        self.assertEqual(wide[-1], {'name': '<more-keys>', 'count_bucket': 'gt-100'})
        self.assertIn('<max-depth>', json.dumps(fields['nestedConfiguration']))
        for secret in ('01234567', '09876543', 'v8ss5qb9km2zde6p', EMAIL, 'pastDepthLimit', 'variant0'):
            self.assertNotIn(secret, result.stdout)

    def test_credential_values_survive_selective_collection_and_shape_caps(self):
        word = 'accounts'
        token = 'privateMarker'
        hidden = {'marker': ACCOUNT}
        for _ in range(12):
            hidden = {'child': hidden}
        script = entry('https://static.chase.com/static/script', mime='text/javascript',
                       text=f'const demo = "{token}";')
        target = entry('https://asset.chase.com/api', text=json.dumps({f'{token}Copy': True, word: True}),
                       request_headers=[header('Cookie', f'demoSession={word}')])
        index = entry('https://secure.chase.com/index',
                      text=json.dumps({'omittedBranch': hidden, 'displayLabel': token}))
        self.har['log']['entries'] = [script, target, index]
        module = runpy.run_path(str(SCRIPT))
        sources = module['InputValues'](self.har, diagnose=True)
        outline = module['make_skeleton'](self.har, None, sources)
        self.assertIn(ACCOUNT, sources.values)
        self.assertNotIn(ACCOUNT, json.dumps(outline))
        self.assertEqual(sources.source_kinds(token.casefold(), False), {'json-scalar'})
        self.assert_refused(self.run_tool('-o', self.destination),
                            ['$.entries[1].response.body.fields[0].name',
                             '$.entries[1].response.body.fields[1].name'], word, token, ACCOUNT)

    def test_auth_form_values_remain_sensitive_even_when_identifier_like(self):
        marker = 'clientLabel'
        lookup = entry('https://secure.chase.com/auth/login', method='POST',
                       post={'mimeType': 'application/x-www-form-urlencoded', 'text': f'input={marker}'})
        echo = entry('https://secure.chase.com/api', text=json.dumps({f'{marker}Copy': True}))
        self.har['log']['entries'] = [lookup, echo]
        self.assert_refused(self.run_tool('-o', self.destination),
                            ['$.entries[1].response.body.fields[0].name'], marker)

    def test_authorization_callback_collects_code_and_state(self):
        marker = 'samplecode'
        echo = entry('https://secure.chase.com/api', text=json.dumps({marker: True}))
        callback = 'https://secure.chase.com/callback?code=samplecode&state=fakedemo'
        for source in (entry(callback), entry('https://secure.chase.com/api',
                                              request_headers=[header('Referer', callback)])):
            self.har['log']['entries'] = [source, echo]
            self.assert_refused(self.run_tool('-o', self.destination),
                                ['$.entries[1].response.body.fields[0].name'], marker)

    def test_omitted_assets_still_collect_suspicious_tokens_and_explicit_credentials(self):
        marker = 'SyntheticMarker'
        short = 'fakekey'
        target = entry('https://secure.chase.com/api', text=json.dumps({marker: True, short: True}))
        cases = (
            ('/dashboard', 'text/html', f'<input type="hidden" name="csrf" value="{marker}">'),
            ('/bootstrap', 'application/javascript', f'window.page = {{"csrf": "{marker}"}};'),
            ('/scripts/example.map', 'application/json', f'{{"token":"{marker}"}}'),
            ('/auth/login', 'text/html', '<script type="application/json">'
                                       f'{{"password":"{short}"}}</script>'),
            ('/auth/login', 'application/javascript', f'window.page = {{password: "{short}"}};'),
        )
        for request_path, mime, text in cases:
            with self.subTest(mime=mime, request_path=request_path):
                asset = entry('https://secure.chase.com' + request_path, mime=mime, text=text)
                self.har['log']['entries'] = [target, asset]
                field_index = 1 if short in text else 0
                self.assert_refused(self.run_tool('-o', self.destination),
                                    [f'$.entries[0].response.body.fields[{field_index}].name'],
                                    marker, short)

    def test_compact_credential_names_and_auth_padding(self):
        marker = 'SyntheticMarker'
        short = 'fakekey'
        target = entry('https://secure.chase.com/api', text=json.dumps({marker: True, short: True}))
        for name in ('x-sessionid', 'x-access-key', 'x-api-key'):
            with self.subTest(header=name):
                source = entry('https://secure.chase.com/api', request_headers=[header(name, marker)])
                self.har['log']['entries'] = [target, source]
                self.assert_refused(self.run_tool('-o', self.destination),
                                    ['$.entries[0].response.body.fields[0].name'], marker)
        for name in ('sessionid', 'userName', 'principal', 'customerName', 'access_key'):
            with self.subTest(json=name):
                source = entry('https://secure.chase.com/api', text=json.dumps({name: marker}))
                self.har['log']['entries'] = [target, source]
                self.assert_refused(self.run_tool('-o', self.destination),
                                    ['$.entries[0].response.body.fields[0].name'], marker)
        source = entry('https://secure.chase.com/auth/login', request_headers=[
            header('Authorization', f'Bearer {short} \t'),
        ])
        self.har['log']['entries'] = [target, source]
        self.assert_refused(self.run_tool('-o', self.destination),
                            ['$.entries[0].response.body.fields[1].name'], short)

    def test_templated_name_still_blocks_a_copy_in_another_field(self):
        original = 'sYntheTICMarker1'
        first = entry('https://secure.chase.com/api', request_headers=[header(original, 'fake')],
                      text=json.dumps({original.lower(): True}))
        self.har['log']['entries'] = [first]
        self.assert_refused(self.run_tool('-o', self.destination),
                            ['$.entries[0].response.body.fields[0].name'], original, original.lower())

    def test_encoded_credential_text_remains_sensitive(self):
        text = 'aaaaaa'
        encoded = base64.b64encode(text.encode()).decode()
        source = entry('https://secure.chase.com/auth', mime='text/plain', text=encoded)
        source['response']['content']['encoding'] = 'base64'
        echo = entry('https://secure.chase.com/api',
                     request_headers=[header(f'x-{encoded.lower()}', 'fake')])
        self.har['log']['entries'] = [source, echo]
        self.assert_refused(self.run_tool('-o', self.destination),
                            ['$.entries[1].request.headers[0]'], text, encoded)

    def test_form_query_and_tag_names_are_templated(self):
        route = 'account/transaction'
        tag = 'ACCOUNTREF7429TOKEN'
        first = entry('https://secure.chase.com/api?'+quote(route, safe='')+'=fake', method='POST',
                      post={'mimeType': 'application/x-www-form-urlencoded',
                            'text': quote(EMAIL, safe='') + '=fake'},
                      mime='application/xml', text=f'<report><{tag}/></report>')
        self.har['log']['entries'] = [first]
        result = self.run_tool()
        outline = self.successful(result)['entries'][0]
        self.assertEqual(outline['query'], [{'name': '<key:route>', 'count_bucket': 'le-1'}])
        self.assertEqual(outline['request']['body'], [{'name': '<key:email>', 'count_bucket': 'le-1'}])
        self.assertEqual(outline['response']['body'], ['report', '<tag:opaque>'])
        for value in (route, tag, EMAIL):
            self.assertNotIn(value, result.stdout)

    def test_download_shape_takes_priority_over_static_resource_hint(self):
        first = entry('https://secure.chase.com/download', mime='application/octet-stream', text=QFX,
                      response_headers=[header('Content-Disposition', f'attachment; filename="{FILE_NAME}"')])
        first['_resourceType'] = 'image'
        self.har['log']['entries'] = [first]
        self.assertEqual(self.successful(self.run_tool())['entries'][0]['response']['body'], TAGS)

    def test_http2_path_only_query_value_is_still_sensitive(self):
        token = 'privateMarker'
        first = entry('https://asset.chase.com/api/accounts',
                      request_headers=[header(':path', '/api/accounts?selected=private%4Darker')],
                      text=json.dumps({f'{token}Copy': True}))
        self.har['log']['entries'] = [first]
        result = self.run_tool('-o', self.destination)
        self.assert_refused(result, ['$.entries[0].response.body.fields[0].name'], token)
        first['request']['headers'][0]['value'] += '#illegal-fragment'
        self.assert_refused(self.run_tool('-o', self.destination), ['Could not read or process the HAR.'], token)

    def test_http2_referer_still_contributes_query_and_identifier_values(self):
        token = 'privateMarker'
        path_fragment = 'retained/marker'
        for authority in ('https://www.chase.com', ''):
            with self.subTest(absolute=bool(authority)):
                referer = f'{authority}/portal/retained%2Fmarker?selected=private%4Darker'
                first = entry(f'https://asset.chase.com/api/{path_fragment}',
                              request_headers=[header('referer', referer)],
                              text=json.dumps({f'{token}Copy': True}))
                self.har['log']['entries'] = [first]
                result = self.run_tool('-o', self.destination)
                self.assert_refused(result, ['$.entries[0].path', '$.entries[0].response.body.fields[0].name',
                                             '$.path_counts[0].path'], token, path_fragment)

    def test_http2_protocol_occurrences_do_not_mask_independent_matches(self):
        origin = 'https://asset.chase.com'
        mime = 'text/plain'
        first = entry(f'{origin}/api', mime=mime,
                      request_headers=[header('X-Private-Value', mime), header('content-type', mime)],
                      response_headers=[header('Accept', mime), header('Access-Control-Allow-Headers', 'content-type')])
        first['_initiator'] = {'url': origin, 'stack': {'callFrames': [{'url': origin}]}}
        first['_custom'] = {'independent': origin}
        self.har['log']['entries'] = [first]
        result = self.run_tool('-o', self.destination)
        self.assert_refused(result, ['$.entries[0].origin', '$.entries[0].request.content_type',
                                     '$.entries[0].response.mime'], origin, mime)

    def test_cors_and_accept_mirrors_require_related_structure(self):
        name = 'synthetic-private-key'
        mime = 'text/plain'
        first = entry('https://asset.chase.com/api', mime=mime,
                      request_headers=[header(name, 'fake')])
        second = entry('https://asset.chase.com/other', response_headers=[
            header('Access-Control-Expose-Headers', name), header('Accept', mime),
        ])
        self.har['log']['entries'] = [first, second]
        self.assert_refused(self.run_tool('-o', self.destination),
                            ['$.entries[0].request.headers[0]', '$.entries[0].response.mime'], name, mime)

        second['response']['headers'].append(header(name, 'fake'))
        second['response']['headers'][0]['value'] = mime
        second['response']['content']['mimeType'] = mime
        self.successful(self.run_tool())

    def test_http2_token_checks_survive_structure_exemptions(self):
        token = 'v8ss5qb9km2zde6p'
        for name in (token, token.upper(), 'qBkaf_LuWslqWKszTmna', 'qbkafluwslqwksztmn_a'):
            with self.subTest(name=name):
                first = entry('https://asset.chase.com/api',
                              request_headers=[header(f'X-{name}', 'fake')],
                              text=json.dumps({name: True}))
                self.har['log']['entries'] = [first]
                result = self.run_tool()
                outline = self.successful(result)['entries'][0]
                self.assertEqual(outline['request']['headers'], ['<key:opaque>'])
                self.assertEqual(outline['response']['body']['fields'],
                                 [{'name': '<key:opaque>', 'count_bucket': 'le-1'}])
                self.assertNotIn(name.lower(), result.stdout.lower())
        self.har['log']['entries'] = [entry(f'https://{token}.chase.com/api', mime=f'text/{token}')]
        self.assert_refused(self.run_tool('-o', self.destination),
                            ['$.entries[0].origin', '$.entries[0].response.mime'], token)

    def test_cors_preflight_requires_matching_later_request(self):
        target = 'https://asset.chase.com/api'
        origin = 'https://www.chase.com:8443'
        name = 'content-type'
        preflight = entry(target, method='OPTIONS', request_headers=[
            header('Origin', origin), header('Access-Control-Request-Method', 'POST'),
            header('Access-Control-Request-Headers', name),
        ], response_headers=[header('Access-Control-Allow-Headers', name),
                             header('Access-Control-Allow-Origin', origin)])
        preflight['response'].update(status=204, headers=preflight['response']['headers'][1:])
        preflight['response']['content']['mimeType'] = ''
        actual = entry(target, seconds='01', method='POST', request_headers=[
            header('Origin', origin), header(name, 'application/json'),
        ])
        self.har['log']['entries'] = [preflight, actual]
        self.successful(self.run_tool())
        self.har['log']['entries'].reverse()
        self.successful(self.run_tool())
        self.har['log']['entries'].reverse()

        original = actual['request']
        for field, wrong in (('url', target + '/other'), ('method', 'GET'), ('origin', target.rsplit('/', 1)[0])):
            with self.subTest(mismatch=field):
                request = copy.deepcopy(original)
                if field == 'origin':
                    request['headers'][0]['value'] = wrong
                else:
                    request[field] = wrong
                actual['request'] = request
                self.assert_refused(self.run_tool('-o', self.destination),
                                    ['$.entries[1].request.headers[0]', '$.entries[1].response.headers[0]'],
                                    name)
        actual['request'] = original
        actual['startedDateTime'], preflight['startedDateTime'] = (
            preflight['startedDateTime'], actual['startedDateTime'])
        paths = ['$.entries[1].request.headers[0]', '$.entries[1].response.headers[0]']
        self.assert_refused(self.run_tool('-o', self.destination), paths, name)
        actual['startedDateTime'], preflight['startedDateTime'] = (
            preflight['startedDateTime'], actual['startedDateTime'])
        preflight['response']['status'] = 403
        self.assert_refused(self.run_tool('-o', self.destination), paths, name)
        preflight['response']['status'] = 204
        same_origin = target.rsplit('/', 1)[0]
        preflight['request']['headers'][0]['value'] = same_origin
        preflight['response']['headers'][1]['value'] = same_origin
        actual['request']['headers'][0]['value'] = same_origin
        self.assert_refused(self.run_tool('-o', self.destination), paths, name)
        preflight['request']['headers'][0]['value'] = origin
        preflight['response']['headers'][1]['value'] = origin
        actual['request']['headers'][0]['value'] = origin
        private_name = 'synthetic-private-key'
        preflight['request']['headers'][2]['value'] = private_name
        preflight['response']['headers'][0]['value'] = private_name
        actual['request']['headers'][1]['name'] = private_name
        self.assert_refused(self.run_tool('-o', self.destination),
                            ['$.entries[1].request.headers[1]', '$.entries[1].response.mime'], private_name)

    def test_chrome_http2_windows_bytes_match_utf8_lf(self):
        text = json.dumps(chrome_http2_har(), indent=2)
        _, lf = self.diagnose(raw=text.encode('utf-8'))
        _, crlf_bom = self.diagnose(raw=b'\xef\xbb\xbf' + text.replace('\n', '\r\n').encode('utf-8'))
        self.assertEqual(lf, crlf_bom)
        self.assertEqual(lf['status'], 'complete')

    def test_diagnose_clean_banking_capture_only_reports_metadata(self):
        self.har = synthetic_banking_har()
        stdout, report = self.diagnose()
        self.assertRegex(report['tool_version'], r'^\d+\.\d+\.\d+$')
        self.assertEqual(report['python_version'], '.'.join(map(str, sys.version_info[:3])))
        self.assertEqual(report['status'], 'complete')
        self.assertEqual(report['entry_count'], 72)
        self.assertEqual(report['offender_count'], 0)
        self.assertEqual(report['buckets'], [])
        for text in (ACCOUNT, EMAIL, JWT, COOKIE, DEVICE, FILE_NAME, TXN_LABEL, *DATES,
                     'secure.chase.com', 'browser-telemetry.example.test', 'recentitems',
                     'includeAccountDetails', 'X-JPMC-CSRF-Token', 'pretendCrossSiteCredential',
                     'Fake account label', 'statementDownloadFormat', 'BANKACCTFROM',
                     'application/vnd.intu.qfx'):
            self.assertNotIn(text.casefold(), stdout.casefold())

    def test_diagnose_reports_rule_field_and_source_counts_with_bounded_examples(self):
        marker = 'privateMarker'
        origin = 'https://portal.jpmorgan.com'
        mime = 'application/privatehint'
        sources = entry(f'https://secure.chase.com/collect?selection=private%4Darker#{marker}',
                        request_headers=[header('X-Source', marker), header('X-Route-Token', 'safemarker'),
                                         header('X-Origin-Token', origin), header('X-Mime-Token', mime)],
                        text=json.dumps({'capturedValue': marker}),
                        post={'mimeType': 'application/x-www-form-urlencoded',
                              'text': 'selection=private%4Darker'})
        sources['request']['cookies'] = [header('shortfake', marker)]
        opaque = entry('https://browser.example.test/resource', mime='text/plain',
                       text=f'hello {marker} done')
        target = entry(f'https://secure.chase.com/api/safemarker?{marker}',
                       request_headers=[header(EMAIL, 'redact everything')],
                       response_headers=[header(marker, 'redact entirely')],
                       text=json.dumps({f'{marker}Copy': True, 'account0742': None,
                                        DATES[0]: True, JWT: True}))
        download = entry('https://secure.chase.com/download', mime='application/qfx',
                         text='<OFX><TRN22.50>synthetic</TRN22.50></OFX>')
        self.har['log']['entries'] = ([copy.deepcopy(target) for _ in range(7)]
                                      + [sources, opaque, entry(f'{origin}/api', mime=mime), download])
        stdout, report = self.diagnose()
        normal = self.run_tool()
        self.assertEqual(normal.returncode, 1)
        self.assertEqual(report['entry_count'], 11)
        self.assertEqual(report['offender_count'], len(normal.stderr.splitlines()))
        buckets = {(row['rule'], row['field_kind']): row for row in report['buckets']}
        copied = buckets['copied-input-value', 'json-key']
        self.assertEqual(copied['count'], 7)
        self.assertEqual(copied['source_kinds'], dict.fromkeys(
            ('body-token', 'cookie', 'form-value', 'header-value', 'json-scalar', 'query-value', 'url'), 7))
        self.assertEqual(copied['examples'], [
            {'field_path': f'$.entries[{i}].response.body.fields[0].name',
             'shape': {'length_bucket': '17-32', 'classes': ['lower', 'upper']}}
            for i in range(5)
        ])
        for kind, count in (('query-name', 7), ('response.header-name', 7), ('path', 7),
                            ('path_counts.path', 1), ('origin', 1), ('mime', 1)):
            self.assertEqual(buckets['copied-input-value', kind]['count'], count)
        self.assertLessEqual(max(map(lambda row: len(row['examples']), report['buckets'])), 5)
        for text in (marker, 'privateMark', 'arkerCopy', origin, mime, 'safemarker', EMAIL,
                     JWT, 'account0742', '0742', DATES[0], '22.50', 'TRN22', 'shortfake',
                     'private%4Darker', 'redact everything', 'redact entirely', 'capturedValue'):
            self.assertNotIn(text.casefold(), stdout.casefold())

    def test_diagnose_keeps_distinct_values_of_the_same_shape_indistinguishable(self):
        reports = []
        for name in ('privateMarker', 'anotherSecret'):
            first = entry('https://secure.chase.com/api', text=json.dumps({f'{name}Copy': True}),
                          request_headers=[header('X-Token', name)])
            self.har['log']['entries'] = [first]
            stdout, _ = self.diagnose()
            self.assertNotIn(name.casefold(), stdout.casefold())
            reports.append(stdout)
        self.assertEqual(*reports)

    def test_diagnose_attributes_a_copy_to_data_and_excludes_the_structural_mirror(self):
        origin = 'https://secure.chase.com'
        self.har['log']['entries'] = [
            entry(f'{origin}/api', request_headers=[header('Cookie', f'syntheticSession={origin}')],
                  response_headers=[header('Access-Control-Allow-Origin', origin)]),
        ]
        stdout, report = self.diagnose()
        self.assertNotIn(origin, stdout)
        self.assertEqual(report['offender_count'], 1)
        copied, = report['buckets']
        self.assertEqual((copied['rule'], copied['field_kind']), ('copied-input-value', 'origin'))
        self.assertEqual(copied['source_kinds'], {'cookie': 1})

    def test_diagnose_separates_short_credential_and_substring_sources(self):
        number = '7042'
        module = runpy.run_path(str(SCRIPT))
        sources = module['InputValues']({}, diagnose=True)
        sources.remember_secret(number, 'cookie')
        sources.remember(number, 'header-value', selective=True)
        diagnostics = module['Diagnostics']()
        # Inject untemplated names to test the final check independently of the renderer.
        outline = {'entries': [{'response': {'headers': [number],
                   'body': {'fields': [{'name': f'account{number}', 'type': '<bool>'}]}}}]}
        offenders = module['self_check'](outline, sources, diagnostics)
        stdout = diagnostics.render(1, len(offenders))
        copied = {bucket['field_kind']: bucket['source_kinds'] for bucket in json.loads(stdout)['buckets']
                  if bucket['rule'] == 'copied-input-value'}
        self.assertEqual(copied, {
            'json-key': {'header-value': 1},
            'response.header-name': {'cookie': 1, 'header-value': 1},
        })
        self.assertNotIn(number, stdout)

    def test_diagnose_suppresses_parser_warnings_with_input_fragments(self):
        self.har['log']['entries'] = [
            entry('https://secure.chase.com/download',
                  response_headers=[header('Content-Disposition',
                                           "attachment; filename*=unicode_escape''%5Cqa-synthetic.qfx")]),
        ]
        stdout, report = self.diagnose(python_flags=('-Wd',))
        self.assertEqual(report['status'], 'complete')
        self.assertNotIn(r'\q', stdout)
        self.assertNotIn('synthetic.qfx', stdout)
        stdout, report = self.diagnose(python_flags=('-Werror',))
        self.assertEqual(report['status'], 'processing-failed')
        self.assertIsNone(report['offender_count'])
        self.assertNotIn(r'\q', stdout)

    def test_diagnose_processing_failure_and_output_flags_are_safe(self):
        stdout, bad_json = self.diagnose(raw=f'{{"malformed":"{JWT}"')
        self.assertNotIn(JWT, stdout)
        self.assertIsNone(bad_json['entry_count'])
        self.assertEqual(bad_json['status'], 'processing-failed')
        self.assertIsNone(bad_json['offender_count'])
        self.assertEqual(bad_json['buckets'], [])
        self.har['log']['entries'][0]['request']['url'] = f'invalid {JWT}'
        stdout, bad_entry = self.diagnose()
        self.assertNotIn(JWT, stdout)
        self.assertEqual(bad_entry['entry_count'], 3)
        self.assertEqual(bad_entry['status'], 'processing-failed')
        self.destination.write_text('sentinel', encoding='utf-8')
        for args in (('-o', self.destination), ('-o', self.destination, '--force'), ('--force',)):
            result = self.run_tool('--diagnose', *args)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(result.stdout, '')
            self.assertEqual(result.stderr, 'Invalid arguments. See --help.\n')
            self.assertEqual(self.destination.read_text(encoding='utf-8'), 'sentinel')

    def test_third_party_and_explicit_hostname_pattern(self):
        self.har['log']['entries'] += [entry('https://secure.chase.com.example.test/help'),
                                       entry('https://api.jpmorganchase.com/help')]
        default = self.successful(self.run_tool())['entries']
        explicit = self.successful(self.run_tool('--include-host-pattern', r'assets\.example\.test'))['entries']
        self.assertEqual(default[2]['origin'], '<third-party>')
        self.assertEqual(default[3]['origin'], '<third-party>')
        self.assertEqual(default[4]['origin'], 'https://api.jpmorganchase.com')
        self.assertEqual(explicit[2]['origin'], f'https://{THIRD_HOST}')
        self.assertEqual(explicit[3]['origin'], '<third-party>')

    def test_templating_decodes_then_discards_unsafe_segments(self):
        parts = [ACCOUNT, '012', 'deadbeefcafe', 'R29vZFNlY3JldA', 'f000000f-abcd-4242-9200-abcd10000032',
                 quote(EMAIL, safe=''), 'token%3Dfake', 'segment-with-punctuation', '%2531']
        self.har['log']['entries'][0]['request']['url'] = 'https://secure.chase.com/api/' + '/'.join(parts)
        outline = self.successful(self.run_tool())
        self.assertEqual(outline['entries'][0]['path'], '/api/' + '/'.join([
            '<id>', '<id>', '<token>', '<token>', '<id>', '<id>', '<token>', '<token>', '<token>']))

    def test_header_shape_templates_abused_structural_slots_without_echo(self):
        for name in (f'X-Account-{ACCOUNT}', 'ZGV2aWNlc2VjcmV0ZmFrZQ', EMAIL,
                     'X-$22.50', 'X-$.42', 'X-11.04.25', 'X-Sep-03-26'):
            with self.subTest(name=name):
                self.har = synthetic_har()
                self.har['log']['entries'][0]['request']['headers'].append(header(name, 'drop the value'))
                result = self.run_tool()
                names = self.successful(result)['entries'][0]['request']['headers']
                self.assertIn('<key:email>' if name == EMAIL else '<key:opaque>', names)
                self.assertNotIn(name, result.stdout)
                module = runpy.run_path(str(SCRIPT))
                self.assertEqual(module['self_check']({'entries': [{'request': {'headers': [name]}}]},
                                                       module['InputValues']({})),
                                 ['$.entries[0].request.headers[0]'])

    def test_self_check_rejects_data_copied_into_a_valid_name_or_path(self):
        self.har['log']['entries'][0]['request']['url'] = 'https://secure.chase.com/api/accountName'
        headers = self.har['log']['entries'][0]['request']['headers']
        headers.extend([header('X-Device', 'accountName'), header('X-Session-Token', 'private-field'),
                        header('Private-Field', 'fake'), header('X-Fake', 'drop')])
        result = self.run_tool()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, '')
        self.assertRegex(result.stderr, r'(?m)^\$\.entries\[0\]\.request\.headers\[\d+\]$')
        self.assertIn('$.entries[0].path\n', result.stderr)
        self.assertRegex(result.stderr, r'(?m)^\$\.path_counts\[\d+\]\.path$')
        self.assertNotIn('accountName', result.stderr)
        self.assertNotIn('private-field', result.stderr)

    def test_self_check_catches_path_if_templating_regresses(self):
        module = runpy.run_path(str(SCRIPT))
        sources = module['InputValues']({})
        outline = {'entries': [{'path': f'/activity/{ACCOUNT}/download'}]}
        self.assertEqual(module['self_check'](outline, sources), ['$.entries[0].path'])

    def assert_refused(self, result, paths, *values):
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, '')
        self.assertEqual(result.stderr.splitlines(), paths)
        self.assertFalse(self.destination.exists())
        for value in values:
            self.assertNotIn(value, result.stderr)

    def test_value_echoed_into_a_json_key_is_refused(self):
        secret = 'privateMarker'
        for source in ('header', 'query', 'form', 'json', 'body', 'web body', 'embedded JSON',
                       'postData', 'multipart', 'nested multipart'):
            with self.subTest(source=source):
                accounts = entry('https://secure.chase.com/api/accounts',
                                 text=json.dumps({f'{secret}Copy': True}))
                source_entry = entry('https://secure.chase.com/lookup')
                request = source_entry['request']
                content = source_entry['response']['content']
                if source == 'header':
                    request['headers'] = [header('X-Device', secret)]
                elif source == 'query':
                    request['url'] += '?lookupHint=private%4Darker'
                elif source == 'form':
                    request['postData'] = {'mimeType': 'application/x-www-form-urlencoded',
                                           'text': 'lookupHint=private%4Darker'}
                elif source == 'json':
                    content['text'] = json.dumps({'privateHint': [secret]})
                elif source == 'body':
                    content.update(mimeType='text/plain', text=f'hello {secret} world')
                elif source == 'web body':
                    request['url'] = 'https://secure.chase.com/auth/lookup'
                    content.update(mimeType='application/javascript', text=f'let variable = "{secret}";')
                elif source == 'embedded JSON':
                    request['url'] = 'https://secure.chase.com/auth/lookup'
                    content.update(mimeType='text/html', text='<script type=application/json>'
                                   r'{"alias":"private\u004darker"}' '</script>')
                elif source == 'postData':
                    request['postData'] = {'mimeType': 'text/plain', 'text': f'hello {secret} world'}
                else:
                    payload = ('Content-Type: application/json\r\n\r\n'
                               r'{"alias":"private\u004darker"}' '\r\n')
                    if source == 'nested multipart':
                        payload = ('Content-Type: multipart/mixed; boundary=innerBoundary\r\n\r\n'
                                   f'--innerBoundary\r\n{payload}--innerBoundary--\r\n')
                    request['postData'] = {
                        'mimeType': 'multipart/form-data; boundary=pretendBoundary',
                        'text': '--pretendBoundary\r\nContent-Disposition: form-data; name="details"\r\n'
                                f'{payload}--pretendBoundary--\r\n',
                    }
                self.har['log']['entries'] = [accounts, source_entry]
                result = self.run_tool('-o', self.destination)
                self.assert_refused(result, ['$.entries[0].response.body.fields[0].name'], secret)

    def test_account_number_in_json_key_is_templated_and_caught_if_retained(self):
        number = '0742'
        accounts = self.har['log']['entries'][0]
        accounts['response']['content']['text'] = json.dumps({f'account{number}': True})
        result = self.run_tool()
        self.assertNotIn(number, result.stdout)
        self.assertEqual(self.successful(result)['entries'][0]['response']['body']['fields'],
                         [{'name': '<key:opaque>', 'count_bucket': 'le-1'}])
        module = runpy.run_path(str(SCRIPT))
        outline = {'entries': [{'response': {'body': {'fields': [{'name': f'account{number}' }]}}}]}
        self.assertEqual(module['self_check'](outline, module['InputValues']({})),
                         ['$.entries[0].response.body.fields[0].name'])

    def test_email_in_header_name_is_templated(self):
        first = entry('https://secure.chase.com/api', request_headers=[header(EMAIL, 'fake')])
        self.har['log']['entries'] = [first]
        result = self.run_tool()
        self.assertEqual(self.successful(result)['entries'][0]['request']['headers'], ['<key:email>'])
        self.assertNotIn(EMAIL, result.stdout)

    def test_first_party_origin_with_a_copied_secret_label_is_refused(self):
        secret = 'privateprofile'
        first = entry(f'https://{secret}.chase.com/api', request_headers=[header('X-Device', secret)])
        self.har['log']['entries'] = [first]
        result = self.run_tool('-o', self.destination)
        self.assert_refused(result, ['$.entries[0].origin'], secret)

    def test_exact_first_party_host_cannot_exempt_a_credential(self):
        host = 'secure.chase.com'
        origin = f'https://{host}'
        for name, value in (('Cookie', f'exampleSession={host}'), ('Authorization', f'Bearer {origin}'),
                            ('X-Api-Key', host), ('X-JPMC-CSRF-Token', origin), ('query', origin)):
            with self.subTest(source=name):
                first = entry(f'{origin}/api',
                              response_headers=[header('Access-Control-Allow-Origin', origin)])
                if name == 'query':
                    first['request']['url'] += f'?access_token={quote(value, safe="")}'
                else:
                    first['request']['headers'] = [header(name, value)]
                self.har['log']['entries'] = [first]
                self.assert_refused(self.run_tool('-o', self.destination), ['$.entries[0].origin'], host)

    def test_timing_origin_and_redirect_headers_can_mirror_the_bank_origin(self):
        origin = 'https://secure.chase.com'
        first = entry(f'{origin}/api', response_headers=[header('Timing-Allow-Origin', origin),
                                                        header('Location', origin)])
        first['response'].update(status=302, redirectURL=origin)
        self.har['log']['entries'] = [first]
        self.assertEqual(self.successful(self.run_tool())['entries'][0]['origin'], origin)
        first['response']['headers'].pop()
        self.assert_refused(self.run_tool('-o', self.destination), ['$.entries[0].origin'], origin)

    def test_base64url_tokens_are_templated_in_structural_names(self):
        token = 'I-sdtByincRGCWbyTRROkg'
        first = entry('https://secure.chase.com/api', text=json.dumps({token: True}),
                      request_headers=[header(f'X-Custom-{token}', 'fake')])
        self.har['log']['entries'] = [first]
        result = self.run_tool()
        outline = self.successful(result)['entries'][0]
        self.assertEqual(outline['request']['headers'], ['<key:opaque>'])
        self.assertEqual(outline['response']['body']['fields'],
                         [{'name': '<key:opaque>', 'count_bucket': 'le-1'}])
        self.assertNotIn(token.lower(), result.stdout.lower())

    def test_web_asset_protocol_literals_and_versioned_names_are_retained(self):
        names = ['addressLine1Verification', 'fido2AuthenticationEnabled', 'maskedPANExpirationDate',
                 'oauth2ClientConfiguration', 'paymentIBANAccount']
        first = entry('https://secure.chase.com/api/accounts', text=json.dumps(dict.fromkeys(names, True)),
                      request_headers=[header('Accept', 'application/merge-patch+json')])
        script = entry('https://assets.example.test/app/script', mime='application/javascript',
                       text='self.fetch("/api/accounts", {headers: {"Content-Type": "application/json; charset=UTF-8"}});'
                            'new window.Request("/api/accounts");')
        page = entry('https://secure.chase.com/home', mime='text/html',
                     text='<a href=/api/accounts>Open</a>'
                          '<script type=application/json>{"addressLine1Verification":true}</script>'
                          '<script type=text/x-javascript>fetch("/api/accounts");</script>'
                          '<script type=application/x-ecmascript>fetch("/api/accounts");</script>'
                          '<svg><image href="/api/accounts" /></svg>'
                          '<style>div { background-image: url("/api/accounts"); }</style>')
        css = entry('https://assets.example.test/app/theme', mime='text/css',
                    text='div { background-image: url("/api/accounts"); }')
        graphql = entry('https://secure.chase.com/api/graphql', mime='application/graphql-response+json')
        xhtml = entry('https://secure.chase.com/home/profile', mime='application/xhtml+xml',
                      text='<script type="application/ld+json">'
                           '<![CDATA[{"@type":]]><![CDATA["WebSite"}]]></script>')
        self.har['log']['entries'] = [first, script, page, css, graphql, xhtml]
        outline = self.successful(self.run_tool())
        self.assertEqual(outline['entries'][0]['path'], '/api/accounts')
        self.assertEqual(outline['entries'][0]['request']['accept'], 'application/merge-patch+json')
        self.assertEqual(outline['entries'][4]['response']['mime'], 'application/graphql-response+json')
        self.assertEqual(outline['entries'][0]['response']['body']['fields'],
                         [header_type(name, '<bool>') for name in names])
        self.assertEqual([item['response']['body'] for item in outline['entries'][1:]],
                         ['<omitted>'] * 5)

    def test_web_source_code_inside_a_string_is_data(self):
        first = entry('https://secure.chase.com/private/marker', mime='application/privatemarker')
        for javascript in ('''const first = 'type="application/privatemarker"';'''
                           '''const second = 'fetch("/private/marker")';''',
                           'logger.url("/private/marker");'
                           'const options = {"Content-Type": "application/json; application/privatemarker"};'):
            script = entry('https://secure.chase.com/auth/script', mime='application/javascript', text=javascript)
            self.har['log']['entries'] = [first, script]
            self.assert_refused(self.run_tool('-o', self.destination),
                                ['$.entries[0].path', '$.entries[0].response.mime', '$.path_counts[1].path'],
                                '/private/marker', 'application/privatemarker')
        page = entry('https://secure.chase.com/auth/home', mime='text/html',
                     text='<style type="text/plain">logger.url("/private/marker");</style>')
        self.har['log']['entries'] = [first, page]
        self.assert_refused(self.run_tool('-o', self.destination),
                            ['$.entries[0].path', '$.path_counts[1].path'], '/private/marker')

    def test_html_markup_values_remain_private(self):
        secret = 'privateMarker'
        first = entry('https://secure.chase.com/api', text=json.dumps({f'{secret}Copy': True}))
        for fragment in (f'<![CDATA[{secret}]]>', f'<?echo {secret}?>',
                         f'<!DOCTYPE html SYSTEM "{secret}">'):
            with self.subTest(fragment=fragment):
                page = entry('https://secure.chase.com/auth/home', mime='application/xhtml+xml', text=fragment)
                self.har['log']['entries'] = [first, page]
                self.assert_refused(self.run_tool('-o', self.destination),
                                    ['$.entries[0].response.body.fields[0].name'], secret)
        self.har['log']['entries'] = [
            first, entry('https://secure.chase.com/auth/home', mime='text/html', text=f'<script>{secret}'),
        ]
        self.assert_refused(self.run_tool('-o', self.destination),
                            ['Could not read or process the HAR.'], secret)

    def test_bare_query_and_form_parameter_names_are_retained(self):
        self.har['log']['entries'] = [
            entry('https://secure.chase.com/api?includeDetails', method='POST',
                  post={'mimeType': 'application/x-www-form-urlencoded', 'text': 'filename'},
                  response_headers=[header('Content-Disposition', 'attachment; filename=""')]),
        ]
        result = self.successful(self.run_tool())['entries'][0]
        self.assertEqual(result['query'], [header_type('includeDetails', '<str:empty>')])
        self.assertEqual(result['request']['body'], [header_type('filename', '<str:empty>')])

    def test_templated_path_token_is_refused_if_it_slips_through(self):
        token = 'retained/marker'
        self.har['log']['entries'] = [
            entry('https://secure.chase.com/activity/' + quote(token, safe='')),
        ]
        self.source.write_text(json.dumps(self.har), encoding='utf-8')
        module = runpy.run_path(str(SCRIPT))
        make_skeleton = module['make_skeleton']

        def faulty_skeleton(*args):
            outline = make_skeleton(*args)
            self.assertEqual(outline['entries'][0]['path'], '/activity/<token>')
            outline['entries'][0]['path'] = f'/activity/{token}'
            return outline

        with (patch.dict(make_skeleton.__globals__, make_skeleton=faulty_skeleton),
              patch.object(sys, 'argv', [str(SCRIPT), str(self.source), '-o', str(self.destination)]),
              redirect_stdout(StringIO()) as stdout, redirect_stderr(StringIO()) as stderr):
            code = module['main']()
        self.assertEqual(code, 1)
        self.assertEqual(stdout.getvalue(), '')
        self.assertEqual(stderr.getvalue(), '$.entries[0].path\n')
        self.assertNotIn(token, stderr.getvalue())
        self.assertFalse(self.destination.exists())

    def test_amount_in_ofx_tag_is_templated_and_caught_if_retained(self):
        amount = '22.50'
        self.har['log']['entries'] = [
            entry('https://secure.chase.com/download', mime='application/qfx',
                  text=f'<OFX><TRN{amount}>fake</TRN{amount}></OFX>'),
        ]
        result = self.run_tool()
        self.assertEqual(self.successful(result)['entries'][0]['response']['body'], ['OFX', '<tag:opaque>'])
        self.assertNotIn(amount, result.stdout)
        module = runpy.run_path(str(SCRIPT))
        outline = {'entries': [{'response': {'body': ['OFX', f'TRN{amount}']}}]}
        self.assertEqual(module['self_check'](outline, module['InputValues']({})),
                         ['$.entries[0].response.body[1]'])

    def test_self_check_refuses_base64_spanning_path_slashes(self):
        candidate = 'VmFsdWVz/QXJlRmFr'
        request = self.har['log']['entries'][0]['request']
        request['url'] = 'https://secure.chase.com/api/' + candidate
        result = self.run_tool('-o', self.destination)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, '')
        self.assertIn('$.entries[0].path\n', result.stderr)
        self.assertNotIn(candidate, result.stderr)
        self.assertFalse(self.destination.exists())

    def test_response_mime_parameters_remain_private(self):
        first = self.har['log']['entries'][0]
        first['response']['content']['mimeType'] = 'application/json; state=fakeName'
        first['request']['headers'].append(header('fakeName', 'ignore'))
        result = self.run_tool()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, '')
        self.assertRegex(result.stderr, r'^\$\.entries\[0\]\.request\.headers\[\d+\]\n$')

    def test_url_and_har_query_use_one_source(self):
        request = self.har['log']['entries'][0]['request']
        request['url'] = 'https://secure.chase.com/api/accounts?to%44ate=09%2F30%2F2026&limit=4&limit=7'
        request['queryString'] = [header('to%44ate', '09%2F30%2F2026'),
                                  header('limit', '4'), header('limit', '7')]
        outline = self.successful(self.run_tool())
        self.assertEqual(outline['entries'][0]['query'], [header_type('limit', '<int>'),
                                                         header_type('limit', '<int>'),
                                                         header_type('toDate', '<date>')])

    def test_http2_path_mirror_and_mixed_case_accept(self):
        first = self.har['log']['entries'][0]
        first['request']['headers'] = [
            header(':path', '/api/accounts'),
            header('Accept', 'Application/JSON'),
            header('If-Modified-Since', 'Wed, 15 Jun 2033 00:00:00 GMT'),
        ]
        first['response']['headers'].append(header('Connection', 'close'))
        first['response']['headers'].append(header('Origin-Agent-Cluster', '?1'))
        outline = self.successful(self.run_tool())['entries'][0]
        self.assertEqual(outline['request']['headers'], [':path', 'accept', 'if-modified-since'])
        self.assertEqual(outline['request']['accept'], 'application/json')
        self.assertIn('connection', outline['response']['headers'])
        self.assertIn('origin-agent-cluster', outline['response']['headers'])

    def test_copies_of_short_credential_parts_are_refused(self):
        for source in ('cookie header', 'cookie array', 'authorization', 'userinfo'):
            with self.subTest(source=source):
                self.har = synthetic_har()
                first = self.har['log']['entries'][0]
                first['response']['content']['text'] = json.dumps({'tidbit': True})
                request = first['request']
                if source == 'cookie header':
                    request['headers'].append(header('Cookie', 'tidbit=stub'))
                elif source == 'cookie array':
                    request['cookies'] = [header('tidbit', 'stub')]
                elif source == 'authorization':
                    request['headers'].append(header('Authorization', 'Bearer tidbit'))
                else:
                    request['url'] = 'https://sample:tidbit@secure.chase.com/api/accounts'
                result = self.run_tool()
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stdout, '')
                self.assertEqual(result.stderr, '$.entries[0].response.body.fields[0].name\n')

    def test_short_credential_copies_in_origin_mime_and_extension_are_refused(self):
        first = self.har['log']['entries'][0]
        first['request']['headers'] = [header('Cookie', 'tidbit=stub')]
        first['request']['url'] = 'https://tidbit.chase.com/api/accounts'
        first['response']['content']['mimeType'] = 'application/tidbit'
        first['response']['headers'].append(header('Content-Disposition', 'attachment; filename=demo.tidbit'))
        result = self.run_tool()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, '')
        self.assertEqual(result.stderr.splitlines(), [
            '$.entries[0].origin', '$.entries[0].response.disposition', '$.entries[0].response.mime'])

    def test_short_credential_that_matches_a_complete_mime_subtype_is_refused(self):
        first = self.har['log']['entries'][0]
        first['request']['headers'] = [header('Cookie', 'tid.bit=stub')]
        first['response']['content']['mimeType'] = 'application/tid.bit'
        result = self.run_tool()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, '')
        self.assertEqual(result.stderr, '$.entries[0].response.mime\n')

    def test_xml_form_ofx_in_an_octet_stream(self):
        content = f'<?xml version="1.0"?><?OFX OFXHEADER="200"?><OFX><ACCTID>{ACCOUNT}</ACCTID></OFX>'
        self.har['log']['entries'] = [entry('https://secure.chase.com/download',
                                          mime='application/octet-stream', text=content)]
        result = self.run_tool()
        self.assertEqual(self.successful(result)['entries'][0]['response']['body'], ['OFX', 'ACCTID'])
        self.assertNotIn(ACCOUNT, result.stdout)

    def test_generic_download_mime_preserves_qfx(self):
        self.har['log']['entries'] = [entry('https://secure.chase.com/download',
                                          mime='application/download', text=QFX)]
        result = self.run_tool()
        self.assertEqual(self.successful(result)['entries'][0]['response']['body'], TAGS)
        self.assertNotIn(ACCOUNT, result.stdout)

    def test_qfx_filename_and_signature_overcome_unknown_download_mime(self):
        disposition = [header('Content-Disposition', f'attachment; filename={FILE_NAME}')]
        self.har['log']['entries'] = [
            entry('https://secure.chase.com/download', mime='application/vnd.vendor.statement',
                  text=QFX, response_headers=disposition),
            entry('https://secure.chase.com/download', mime='application/xhtml+xml',
                  text='<html><p>Private</p></html>', response_headers=disposition),
        ]
        result = self.run_tool()
        outline = self.successful(result)['entries']
        self.assertEqual(outline[0]['response']['body'], TAGS)
        self.assertEqual(outline[1]['response']['body'], '<omitted>')

    def test_long_encoded_json_value_reduces_to_a_hint(self):
        capture = self.har['log']['entries'][0]
        capture['response']['content']['text'] = json.dumps({'download': 'A' * 65_536})
        body = self.successful(self.run_tool())['entries'][0]['response']['body']
        self.assertEqual(body['fields'], [header_type('download', '<id>')])

    def test_timestamp_formats_are_supported_on_python_310(self):
        original, download, _ = self.har['log']['entries']
        original['startedDateTime'] = '2026-10-01T12:00:00.0Z'
        download['startedDateTime'] = '2026-10-01T08:00:01.612345678-0400'
        outline = self.successful(self.run_tool())['entries']
        self.assertEqual([entry['relative_seconds'] for entry in outline], [0, 2, 2])

    def test_extended_filename_takes_precedence(self):
        self.har['log']['entries'][1]['response']['headers'] = [
            header('Content-Disposition', "attachment; filename=download.bin; filename*=UTF-8''checking%20export.qfx"),
        ]
        outline = self.successful(self.run_tool())
        self.assertEqual(outline['entries'][1]['response']['disposition'], 'attachment; filename=<name>.qfx')

    def test_malformed_input_and_invalid_arguments_do_not_echo(self):
        for raw in (f'{{"secret":"{JWT}"', f'{{"log":{{"entries":"{JWT}"}}}}',
                    '{"log":{"entries":[],"entries":[]}}', '{"log":{"entries":[NaN]}}'):
            with self.subTest(raw=raw):
                result = self.run_tool('-o', self.destination, raw=raw)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stdout, '')
                self.assertEqual(result.stderr, 'Could not read or process the HAR.\n')
                self.assertFalse(self.destination.exists())
        result = self.run_tool('--include-host-pattern', f'({JWT}')
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stderr, 'Invalid arguments. See --help.\n')

    def test_nested_body_and_multipart_shapes(self):
        payload = json.dumps({'selected': [{'email': EMAIL, 'accountId': ACCOUNT}, {'private': JWT}],
                              'active': True, '_localNote': COOKIE})
        boundary = 'fakeBoundaryWithNoDisclosure'
        mime = f'multipart/form-data; boundary={boundary}'
        multipart = (f'--{boundary}\r\nContent-Disposition: form-data; name="upload"; filename="{FILE_NAME}"\r\n'
                     f'Content-Type: application/octet-stream\r\n\r\n{ACCOUNT}\r\n--{boundary}--\r\n')
        self.har['log']['entries'] = [
            entry('https://secure.chase.com/query', method='POST', post={'mimeType': 'application/json', 'text': payload}),
            entry('https://secure.chase.com/upload', method='POST', post={'mimeType': mime, 'text': multipart}),
            entry('https://secure.chase.com/upload', method='POST', post={'mimeType': 'text/plain', 'text': ACCOUNT}),
        ]
        result = self.run_tool()
        outline = self.successful(result)['entries']
        self.assertEqual(outline[0]['request']['body']['fields'][0], header_type('active', '<bool>'))
        selected = outline[0]['request']['body']['fields'][1]['type']
        self.assertEqual(selected['first']['fields'], [header_type('accountId', '<id>'), header_type('email', '<id>')])
        self.assertEqual(outline[1]['request']['body'], [{'name': 'upload'}])
        self.assertEqual(outline[2]['request']['body'], '<body:text/plain:le-128>')
        for secret in (EMAIL, ACCOUNT, JWT, COOKIE, boundary, FILE_NAME, '_localNote'):
            self.assertNotIn(secret, result.stdout)

    def test_base64_and_xml_preserve_only_real_tags(self):
        source = f'<report attr="{EMAIL}"><ref>{ACCOUNT}</ref><!-- <commentTag/> -->' \
                 f'<![CDATA[<fakeTag/>]]><ref>{JWT}</ref><empty/></report>'
        xml = entry('https://secure.chase.com/report', mime='application/xml',
                    text=base64.b64encode(source.encode()).decode())
        xml['response']['content']['encoding'] = 'base64'
        qfx = copy.deepcopy(self.har['log']['entries'][1])
        qfx['response']['content'].update(text=base64.b64encode(QFX.encode()).decode(), encoding='base64')
        self.har['log']['entries'] = [xml, qfx]
        result = self.run_tool()
        outline = self.successful(result)['entries']
        self.assertEqual(outline[0]['response']['body'], ['report', 'ref', 'empty'])
        self.assertEqual(outline[1]['response']['body'], TAGS)
        self.assertNotIn(EMAIL, result.stdout)
        self.assertNotIn(ACCOUNT, result.stdout)
        self.assertNotIn(JWT, result.stdout)

    def test_malformed_recognized_bodies_fail_closed(self):
        for mime, text in [('application/json', f'{{"bad":"{JWT}"'),
                           ('application/xml', f'<!DOCTYPE ofx [<!ENTITY tag "{JWT}">]><ofx>&tag;</ofx>')]:
            with self.subTest(mime=mime):
                self.har['log']['entries'] = [entry('https://secure.chase.com/report', mime=mime, text=text)]
                result = self.run_tool()
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stdout, '')
                self.assertEqual(result.stderr, 'Could not read or process the HAR.\n')

    def test_output_mode_no_clobber_and_force(self):
        first = self.run_tool('-o', self.destination)
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(first.stdout, '')
        if os.name == 'posix':
            self.assertEqual(stat.S_IMODE(self.destination.stat().st_mode), 0o600)
        original = self.destination.read_bytes()
        self.har['log']['entries'] = []
        denied = self.run_tool('-o', self.destination)
        self.assertEqual(denied.returncode, 1)
        self.assertEqual(original, self.destination.read_bytes())
        replaced = self.run_tool('-o', self.destination, '--force')
        self.assertEqual(replaced.returncode, 0, replaced.stderr)
        self.assertEqual(json.loads(self.destination.read_text())['entries'], [])
        if os.name == 'posix':
            self.assertEqual(stat.S_IMODE(self.destination.stat().st_mode), 0o600)
        same = self.run_tool('-o', self.source, '--force')
        self.assertEqual(same.returncode, 1)
        self.assertEqual(json.loads(self.source.read_text()), self.har)

    @unittest.skipUnless(os.name == 'posix', 'requires POSIX symlink support')
    def test_force_replaces_destination_symlink_without_following(self):
        other = self.destination.with_name('existing.txt')
        other.write_text('leave this unchanged')
        self.destination.symlink_to(other)
        denied = self.run_tool('-o', self.destination)
        self.assertEqual(denied.returncode, 1)
        self.assertTrue(self.destination.is_symlink())
        replaced = self.run_tool('-o', self.destination, '--force')
        self.assertEqual(replaced.returncode, 0, replaced.stderr)
        self.assertFalse(self.destination.is_symlink())
        self.assertEqual(other.read_text(), 'leave this unchanged')
        self.assertEqual(stat.S_IMODE(self.destination.stat().st_mode), 0o600)


def header_type(name, hint):
    return {'name': name, 'type': hint}
