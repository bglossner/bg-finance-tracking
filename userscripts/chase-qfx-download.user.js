// ==UserScript==
// @name         Chase QFX downloads
// @description  Download Chase activity as QFX from the signed-in dashboard.
// @version      1.0.0
// @match        https://secure.chase.com/web/auth/dashboard
// @grant        none
// @noframes
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  const origin = 'https://secure.chase.com';
  const dashboardPath = '/web/auth/dashboard';
  const listPath = '/svc/rl/accounts/l4/v1/app/data/list';
  const cardPath = '/svc/rr/accounts/secure/gateway/credit-card/transactions/inquiry-maintenance/digital-transaction-activity/v1/transaction-activities';
  const depositPath = '/svc/rr/accounts/secure/v1/account/activity/download/dda/list';
  const formContentType = 'application/x-www-form-urlencoded; charset=UTF-8';
  const accept = 'application/json, text/plain, */*';
  const storagePrefix = 'bgfin.chase-qfx.v1.';
  const delayMs = 700;

  function validDate(date) {
    if (typeof date !== 'string' || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(date)) return false;
    const value = new Date(`${date}T00:00:00Z`);
    return Number.isFinite(value.getTime()) && value.toISOString().slice(0, 10) === date;
  }

  function shiftDays(date, days) {
    const value = new Date(`${date}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
  }

  function localToday(now = new Date()) {
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${now.getFullYear()}-${month}-${day}`;
  }

  function defaultRange(today, checkpoint) {
    const hasCheckpoint = validDate(checkpoint) && checkpoint <= today;
    return { from: hasCheckpoint ? shiftDays(checkpoint, -3) : shiftDays(today, -30), to: today };
  }

  function validRange(from, to) {
    return validDate(from) && validDate(to) && from <= to;
  }

  function filename(last4, from, to) {
    if (typeof last4 !== 'string' || !/^\d{4}$/.test(last4) || !validRange(from, to)) {
      throw new Error('Invalid account mask or download dates.');
    }
    return `Chase${last4}_Activity_${from}_${to}.QFX`;
  }

  function accountListRequest() {
    return { path: listPath, method: 'POST', headers: { Accept: accept, 'Content-Type': formContentType } };
  }

  function downloadRequest(account, from, to, token) {
    if (!validRange(from, to) || typeof account.id !== 'string' || !account.id.trim() ||
        typeof token !== 'string' || !token.trim()) {
      throw new Error('Invalid download request.');
    }
    const start = from.replaceAll('-', '');
    const end = to.replaceAll('-', '');
    if (account.family === 'card') {
      const query = new URLSearchParams({
        'digital-account-identifier': account.id,
        'start-date': start,
        'end-date': end,
        'account-activity-download-type-code': 'QFX',
        csrftoken: token,
        submit: 'Submit',
        'eligibility-indicator': 'true',
      });
      return { path: `${cardPath}?${query}`, method: 'GET', headers: { Accept: accept, 'Content-Type': 'application/json; charset=UTF-8' } };
    }
    if (account.family === 'deposit') {
      const body = new URLSearchParams({
        transactionType: 'ALL',
        filterTranType: 'ALL',
        statementPeriodId: 'ALL',
        downloadType: 'QFX',
        accountId: account.id,
        dateHi: end,
        dateLo: start,
        csrftoken: token,
        submit: 'Submit',
      });
      return { path: depositPath, method: 'POST', headers: { 'Content-Type': formContentType }, body: body.toString() };
    }
    throw new Error('Unsupported Chase account type.');
  }

  function maskedSuffix(mask) {
    return typeof mask === 'string' ? /^[0-9Xx*• -]*(\d{4})$/.exec(mask.trim())?.[1] : undefined;
  }

  function maskedLabel(family, detailType, mask) {
    const detail = typeof detailType === 'string' ? detailType.toUpperCase() : '';
    let label = family === 'card' ? 'Credit card' : 'Deposit account';
    if (family === 'deposit' && detail === 'CHECKING') label = 'Checking';
    if (family === 'deposit' && detail === 'SAVINGS') label = 'Savings';
    const suffix = maskedSuffix(mask);
    return suffix ? `${label} …${suffix}` : label;
  }

  function cacheResponses(payload) {
    return Array.isArray(payload?.cache) ? payload.cache.map(entry => entry?.response) : [];
  }

  function readAccounts(payload) {
    const lists = cacheResponses(payload).filter(response => Array.isArray(response?.accountTiles));
    if (lists.length !== 1 || !Array.isArray(lists[0].personalTileGroups)) {
      throw new Error('Chase account list has an unfamiliar shape.');
    }
    const { accountTiles, personalTileGroups } = lists[0];
    const groups = personalTileGroups.filter(group => group && typeof group === 'object');
    const deposits = new Set(groups.flatMap(group => Array.isArray(group.depositAccountTileIds) ? group.depositAccountTileIds : []));
    const cards = new Set(groups.flatMap(group => Array.isArray(group.creditCardAccountTileIds) ? group.creditCardAccountTileIds : []));
    const accounts = [];
    const seen = new Set();
    for (const tile of accountTiles) {
      if (!tile || tile.unavailable === true || tile.tileDetail?.closed === true || tile.tileDetail?.showActivity === false) continue;
      const isDeposit = deposits.has(tile.tileId);
      const isCard = cards.has(tile.tileId);
      const id = tile.accountId;
      const last4 = maskedSuffix(tile.mask);
      if (isDeposit === isCard || typeof id !== 'string' || !id.trim() || !last4 || seen.has(id)) continue;
      const family = isCard ? 'card' : 'deposit';
      const label = maskedLabel(family, tile.accountTileDetailType, tile.mask);
      accounts.push({ id, family, last4, label });
      seen.add(id);
    }
    return accounts;
  }

  function readCsrfToken(payload) {
    const tokens = cacheResponses(payload).map(response => response?.csrfToken)
      .filter(token => typeof token === 'string' && token.trim());
    if (tokens.length !== 1) throw new Error('Chase did not supply a session token.');
    return tokens[0];
  }

  function isOfx(text, expectedFamily, expectedLast4) {
    const trimmed = text.trim();
    let root = trimmed;
    if (/^OFXHEADER:\s*\d+\b/i.test(trimmed)) {
      const start = trimmed.search(/<OFX\s*>/i);
      if (start < 0 || !/^(?:[A-Z]+:[^<>\r\n]*\s*)+$/i.test(trimmed.slice(0, start))) return false;
      root = trimmed.slice(start);
    }
    if (!/^<OFX\s*>[^]*<\/OFX\s*>$/i.test(root)) return false;
    const statements = [...root.matchAll(/<(STMTRS|CCSTMTRS)\s*>/gi)];
    if (statements.length !== 1) return false;
    const family = statements[0][1].toUpperCase() === 'CCSTMTRS' ? 'card' : 'deposit';
    if (expectedFamily !== undefined && expectedFamily !== family) return false;
    const envelope = family === 'card'
      ? /<CREDITCARDMSGSRSV1\s*>\s*<CCSTMTTRNRS\s*>[^]*?<CCSTMTRS\s*>([^]*?)<\/CCSTMTRS\s*>\s*<\/CCSTMTTRNRS\s*>\s*<\/CREDITCARDMSGSRSV1\s*>/i
      : /<BANKMSGSRSV1\s*>\s*<STMTTRNRS\s*>[^]*?<STMTRS\s*>([^]*?)<\/STMTRS\s*>\s*<\/STMTTRNRS\s*>\s*<\/BANKMSGSRSV1\s*>/i;
    const account = family === 'card'
      ? /^\s*<CURDEF\s*>\s*[A-Z]{3}\s*(?:<\/CURDEF\s*>)?\s*<CCACCTFROM\s*>([^]*?)<\/CCACCTFROM\s*>/i
      : /^\s*<CURDEF\s*>\s*[A-Z]{3}\s*(?:<\/CURDEF\s*>)?\s*<BANKACCTFROM\s*>([^]*?)<\/BANKACCTFROM\s*>/i;
    const accountFields = account.exec(envelope.exec(root)?.[1] ?? '')?.[1];
    if (accountFields === undefined) return false;
    if (expectedLast4 !== undefined) {
      const ids = [...root.matchAll(/<ACCTID\s*>([^<]*)/gi)];
      const accountId = /<ACCTID\s*>([^<]*)/i.exec(accountFields)?.[1].trim() ?? '';
      const suffix = /^[0-9Xx*]*(\d{4})$/.exec(accountId)?.[1];
      if (ids.length !== 1 || suffix !== expectedLast4) return false;
    }
    const statuses = [...root.matchAll(/<STATUS\s*>([^]*?)<\/STATUS\s*>/gi)];
    return statuses.length > 0 && statuses.length === (root.match(/<STATUS\s*>/gi) ?? []).length &&
      statuses.every(([, status]) => {
        const codes = [...status.matchAll(/<CODE\s*>([^<\r\n]*)/gi)];
        return codes.length === 1 && /^0+$/.test(codes[0][1].trim()) &&
          !/<SEVERITY\s*>\s*(?:ERROR|FATAL)\b/i.test(status);
      });
  }

  if (typeof window === 'undefined') {
    if (typeof module !== 'undefined') {
      module.exports = { localToday, defaultRange, validRange, filename, accountListRequest, downloadRequest, maskedLabel, readAccounts, readCsrfToken, isOfx };
    }
    return;
  }
  function onDashboard() {
    return window.top === window && location.origin === origin && location.pathname === dashboardPath;
  }

  if (!onDashboard()) return;

  function isActive(visit) {
    return !visit.aborted && onDashboard();
  }

  function chaseFetch({ path, ...options }, visit) {
    if (!isActive(visit)) throw new Error('Open the signed-in Chase dashboard.');
    return fetch(new URL(path, origin), {
      ...options,
      mode: 'same-origin',
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.any([visit, AbortSignal.timeout(30_000)]),
    });
  }

  async function getAccountData(visit) {
    const response = await chaseFetch(accountListRequest(), visit);
    if (!response.ok) throw new Error('Chase account list request failed.');
    return response.json();
  }

  async function getQfx(account, from, to, visit) {
    const payload = await getAccountData(visit);
    const current = readAccounts(payload).find(entry => entry.id === account.id &&
      entry.family === account.family && entry.last4 === account.last4);
    if (!current) throw new Error('Chase account list has changed.');
    const response = await chaseFetch(downloadRequest(current, from, to, readCsrfToken(payload)), visit);
    if (!response.ok) throw new Error('Chase download request failed.');
    const blob = await response.blob();
    return isOfx(await blob.text(), account.family, account.last4) ? blob : null;
  }

  async function dateKey(id) {
    const bytes = new TextEncoder().encode(`${storagePrefix}${id}`);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return storagePrefix + Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function readCheckpoint(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function rememberDate(key, date) {
    try {
      const prior = readCheckpoint(key);
      if (!validDate(prior) || prior < date) localStorage.setItem(key, date);
      return true;
    } catch {
      return false;
    }
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.append(link);
    try {
      link.click();
    } finally {
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  }

  function delay() {
    return new Promise(resolve => setTimeout(resolve, delayMs));
  }

  async function downloadOne(row, from, to, visit) {
    row.save.hidden = true;
    row.pendingEnd = null;
    let message;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const blob = await getQfx(row.account, from, to, visit);
        if (blob && isActive(visit)) {
          downloadBlob(blob, filename(row.account.last4, from, to));
          row.pendingEnd = to;
          row.save.hidden = false;
          return `Check Downloads for the file covering ${from} to ${to}.`;
        }
        message = 'Chase returned an invalid QFX, an OFX error, or a different account. No file was sent.';
      } catch {
        message = 'Download failed. Check the Chase session and date range. No file was sent.';
      }
      if (!isActive(visit)) break;
      if (attempt === 0) await delay();
    }
    return message;
  }

  function element(tag, text) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    return node;
  }

  function button(text) {
    const node = element('button', text);
    node.type = 'button';
    return node;
  }

  function dateField(text, rangeDate, today) {
    const label = element('label', text);
    const input = element('input');
    input.type = 'date';
    input.max = today;
    input.value = rangeDate;
    label.append(input);
    return { label, input };
  }

  const host = element('div');
  const shadow = host.attachShadow({ mode: 'closed' });
  const styles = new CSSStyleSheet();
  styles.replaceSync(`
    :host { position: fixed; z-index: 10000; right: 1rem; bottom: 1rem; font: 15px/1.45 system-ui, sans-serif;
      color: #172a3b; color-scheme: light; }
    *, *::before, *::after { box-sizing: border-box; }
    details { background: #fff; border: 1px solid #a6b8c8; border-radius: .6rem; box-shadow: 0 4px 18px #112b4526; }
    summary { background: #064b83; color: #fff; font-weight: 650; cursor: pointer; padding: .65rem .9rem; border-radius: .5rem; }
    section { width: min(22rem, calc(100vw - 2rem)); max-height: min(72vh, 34rem); overflow: auto; padding: .9rem; }
    fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
    article { padding: .75rem 0; border-top: 1px solid #d5dfe8; }
    h2 { margin: 0 0 .4rem; font-size: 1rem; }
    .dates { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 8.5rem), 1fr)); gap: .5rem; margin-bottom: .55rem; }
    label { display: block; font-size: .86rem; font-weight: 550; }
    input { display: block; width: 100%; min-width: 0; margin-top: .15rem; }
    input, button { font: inherit; color: inherit; border: 1px solid #7e94a7; background: #fff; border-radius: .3rem; padding: .35rem .55rem; }
    button { cursor: pointer; }
    button:disabled { opacity: .55; cursor: default; }
    .primary { background: #064b83; color: #fff; border-color: #064b83; }
    .save { margin-left: .4rem; }
    :focus-visible { outline: 2px solid #1670b8; outline-offset: 2px; }
    summary:focus-visible { outline-offset: -4px; outline-color: #fff; }
    p { margin: .45rem 0 .65rem; font-size: .88rem; }
    p:empty { display: none; }
    article:last-child { padding-bottom: 0; }
  `);
  shadow.adoptedStyleSheets = [styles];
  const disclosure = element('details');
  const panel = element('section');
  const allButton = button('Download all');
  allButton.className = 'primary';
  allButton.hidden = true;
  const status = element('p');
  status.setAttribute('role', 'status');
  const fields = element('fieldset');
  panel.append(allButton, status, fields);
  disclosure.append(element('summary', 'Chase QFX'), panel);
  shadow.append(disclosure);
  document.body.append(host);

  const rows = [];
  let loading = false;
  let loaded = false;
  let busy = false;
  let dashboardVisit = new AbortController();

  function syncPanelVisibility() {
    host.hidden = !onDashboard();
    if (host.hidden) {
      dashboardVisit.abort();
      disclosure.open = false;
      loaded = false;
      rows.length = 0;
      allButton.hidden = true;
      fields.replaceChildren();
    } else if (dashboardVisit.signal.aborted) {
      dashboardVisit = new AbortController();
    }
  }

  async function run(selected) {
    const visit = dashboardVisit.signal;
    if (busy || !isActive(visit)) return;
    const requests = selected.map(row => ({ row, from: row.from.value, to: row.to.value }));
    busy = allButton.disabled = fields.disabled = true;
    status.textContent = 'Requesting QFX downloads…';
    try {
      await navigator.locks.request(storagePrefix, { ifAvailable: true }, async lock => {
        if (!lock) {
          status.textContent = 'A Chase QFX download is running in another tab.';
          return;
        }
        let index = 0;
        const today = localToday();
        for (const { row, from, to } of requests) {
          if (!isActive(visit)) break;
          if (!validRange(from, to) || to > today) {
            row.status.textContent = 'Choose a valid date range ending today or earlier.';
            continue;
          }
          if (index++ > 0) await delay();
          if (!isActive(visit)) break;
          row.status.textContent = 'Requesting QFX…';
          row.status.textContent = await downloadOne(row, from, to, visit);
        }
        if (isActive(visit)) status.textContent = '';
      });
    } catch {
      if (isActive(visit)) status.textContent = 'Could not start the download. Reload the Chase dashboard and try again.';
    } finally {
      busy = allButton.disabled = fields.disabled = false;
    }
  }

  async function makeRow(account, today) {
    const key = await dateKey(account.id);
    const range = defaultRange(today, readCheckpoint(key));
    const from = dateField('Start date', range.from, today);
    const to = dateField('End date', range.to, today);
    const dates = element('div');
    dates.className = 'dates';
    dates.append(from.label, to.label);
    const action = button('Download QFX');
    action.setAttribute('aria-label', `Download QFX for ${account.label}`);
    const status = element('p');
    status.setAttribute('role', 'status');
    const save = button('Confirm file saved');
    save.className = 'save';
    save.hidden = true;
    save.setAttribute('aria-label', `Confirm file saved for ${account.label}`);
    const row = { account, key, from: from.input, to: to.input, status, save, pendingEnd: null };
    action.addEventListener('click', () => void run([row]));
    save.addEventListener('click', () => {
      if (!onDashboard() || !row.pendingEnd) return;
      status.textContent = rememberDate(key, row.pendingEnd) ? 'Download date recorded.' : 'Date storage is unavailable.';
      row.pendingEnd = null;
      save.hidden = true;
    });
    const article = element('article');
    article.append(element('h2', account.label), dates, action, save, status);
    return { row, article };
  }

  async function loadAccounts() {
    const visit = dashboardVisit.signal;
    if (!isActive(visit) || !disclosure.open || loaded || loading) return;
    loading = true;
    status.textContent = 'Loading Chase accounts…';
    try {
      const accounts = readAccounts(await getAccountData(visit));
      const today = localToday();
      const entries = await Promise.all(accounts.map(account => makeRow(account, today)));
      if (!isActive(visit) || !disclosure.open) return;
      for (const { row, article } of entries) {
        rows.push(row);
        fields.append(article);
      }
      allButton.hidden = rows.length === 0;
      status.textContent = rows.length ? '' : 'Chase returned no eligible deposit or credit card accounts.';
      loaded = rows.length > 0;
    } catch {
      if (isActive(visit)) status.textContent = 'Could not load accounts. Check the Chase session, then close and reopen this panel.';
    } finally {
      loading = false;
      if (visit.aborted) void loadAccounts();
    }
  }

  allButton.addEventListener('click', () => void run(rows));
  disclosure.addEventListener('toggle', () => void loadAccounts());
  window.navigation?.addEventListener('currententrychange', syncPanelVisibility);
  window.addEventListener('popstate', syncPanelVisibility);
})();
