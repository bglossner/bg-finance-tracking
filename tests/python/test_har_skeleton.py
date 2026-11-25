"""Synthetic, offline coverage of the HAR skeleton command."""

import base64
from contextlib import redirect_stderr, redirect_stdout
import copy
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
from urllib.parse import quote


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


class HarSkeletonTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.source = Path(self.directory.name) / 'synthetic.har'
        self.destination = Path(self.directory.name) / 'out.json'
        self.har = synthetic_har()

    def run_tool(self, *args, raw=None):
        self.source.write_text(json.dumps(self.har) if raw is None else raw, encoding='utf-8')
        return subprocess.run([sys.executable, '-I', str(SCRIPT), str(self.source), *map(str, args)],
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

    def test_self_check_refuses_abused_structural_slots_without_echo(self):
        for name in (f'X-Account-{ACCOUNT}', 'ZGV2aWNlc2VjcmV0ZmFrZQ', EMAIL,
                     'X-$22.50', 'X-$.42', 'X-11.04.25', 'X-Sep-03-26'):
            with self.subTest(name=name):
                self.har = synthetic_har()
                self.har['log']['entries'][0]['request']['headers'].append(header(name, 'drop the value'))
                result = self.run_tool('-o', self.destination)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, '')
                self.assertRegex(result.stderr, r'^\$\.entries\[0\]\.request\.headers\[\d+\]\n$')
                self.assertNotIn(name, result.stderr)
                self.assertFalse(self.destination.exists())

    def test_self_check_rejects_data_copied_into_a_valid_name_or_path(self):
        self.har['log']['entries'][0]['request']['url'] = 'https://secure.chase.com/api/accountName'
        headers = self.har['log']['entries'][0]['request']['headers']
        headers.extend([header('X-Device', 'accountName'), header('candidate', 'private-field'),
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
                    content.update(mimeType='application/javascript', text=f'let variable = "{secret}";')
                elif source == 'embedded JSON':
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

    def test_account_number_in_json_key_is_refused(self):
        number = '0742'
        accounts = self.har['log']['entries'][0]
        accounts['response']['content']['text'] = json.dumps({f'account{number}': True})
        result = self.run_tool('-o', self.destination)
        self.assert_refused(result, ['$.entries[0].response.body.fields[0].name'], number)

    def test_email_in_header_name_is_refused(self):
        first = entry('https://secure.chase.com/api', request_headers=[header(EMAIL, 'fake')])
        self.har['log']['entries'] = [first]
        result = self.run_tool('-o', self.destination)
        self.assert_refused(result, ['$.entries[0].request.headers[0]'], EMAIL)

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

    def test_base64url_tokens_are_refused_in_structural_names(self):
        token = 'I-sdtByincRGCWbyTRROkg'
        first = entry('https://secure.chase.com/api', text=json.dumps({token: True}),
                      request_headers=[header(f'X-Custom-{token}', 'fake')])
        self.har['log']['entries'] = [first]
        self.assert_refused(self.run_tool('-o', self.destination),
                            ['$.entries[0].request.headers[0]', '$.entries[0].response.body.fields[0].name'],
                            token, token.lower())

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
            script = entry('https://assets.example.test/script', mime='application/javascript', text=javascript)
            self.har['log']['entries'] = [first, script]
            self.assert_refused(self.run_tool('-o', self.destination),
                                ['$.entries[0].path', '$.entries[0].response.mime', '$.path_counts[0].path'],
                                '/private/marker', 'application/privatemarker')
        page = entry('https://secure.chase.com/home', mime='text/html',
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
                page = entry('https://secure.chase.com/home', mime='application/xhtml+xml', text=fragment)
                self.har['log']['entries'] = [first, page]
                self.assert_refused(self.run_tool('-o', self.destination),
                                    ['$.entries[0].response.body.fields[0].name'], secret)
        self.har['log']['entries'] = [
            first, entry('https://secure.chase.com/home', mime='text/html', text=f'<script>{secret}'),
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

    def test_amount_in_ofx_tag_is_refused(self):
        amount = '22.50'
        self.har['log']['entries'] = [
            entry('https://secure.chase.com/download', mime='application/qfx',
                  text=f'<OFX><TRN{amount}>fake</TRN{amount}></OFX>'),
        ]
        result = self.run_tool('-o', self.destination)
        self.assert_refused(result, ['$.entries[0].response.body[1]'], amount)

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
