  "use strict";

  function validDate(date) {
    if (typeof date !== "string" || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(date))
      return false;
    const value = new Date(`${date}T00:00:00Z`);
    return (
      Number.isFinite(value.getTime()) &&
      value.toISOString().slice(0, 10) === date
    );
  }

  function shiftDays(date, days) {
    const value = new Date(`${date}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
  }

  function localToday(now = new Date()) {
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${now.getFullYear()}-${month}-${day}`;
  }

  function defaultRange(today, checkpoint) {
    const hasCheckpoint = validDate(checkpoint) && checkpoint <= today;
    return {
      from: hasCheckpoint ? shiftDays(checkpoint, -3) : shiftDays(today, -30),
      to: today,
    };
  }

  function validRange(from, to) {
    return validDate(from) && validDate(to) && from <= to;
  }

  function ofxStatus(status) {
    const fields =
      /^\s*<CODE\s*>\s*(\d{1,6})\s*(?:<\/CODE\s*>)?\s*(?:<SEVERITY\s*>([^<]*)(?:<\/SEVERITY\s*>)?\s*)?(?:<MESSAGE\s*>[^<]*(?:<\/MESSAGE\s*>)?\s*)?$/i.exec(status);
    if (!fields) return { ok: false, reason: "not-ofx" };
    const code = Number(fields[1]);
    const severity = fields[2]?.trim().toUpperCase();
    if (code !== 0 || severity === "ERROR" || severity === "FATAL")
      return { ok: false, reason: "status-error", code };
    return severity === "INFO" || severity === "WARN"
      ? { ok: true }
      : { ok: false, reason: "not-ofx" };
  }

  function ofxPostedDate(transaction) {
    const fields = [...transaction.matchAll(/<DTPOSTED\s*>([^<]*)/gi)];
    if (fields.length !== 1) return undefined;
    const date =
      /^(\d{4})(\d{2})(\d{2})(?:\d{6}(?:\.\d+)?(?:\[[^\]]+\])?)?$/.exec(
        fields[0][1].trim(),
      );
    return date ? `${date[1]}-${date[2]}-${date[3]}` : undefined;
  }

  function validateOfx(text, expectedFamily, expectedLast4, from, to) {
    const invalid = { ok: false, reason: "not-ofx" };
    const noStatement = { ok: false, reason: "no-statement" };
    const trimmed = text.trim();
    let root = trimmed;
    if (/^OFXHEADER:\s*\d+\b/i.test(trimmed)) {
      const start = trimmed.search(/<OFX\s*>/i);
      if (
        start < 0 ||
        !/^(?:[A-Z]+:[^<>\r\n]*\s*)+$/i.test(trimmed.slice(0, start))
      )
        return invalid;
      root = trimmed.slice(start);
    }
    root = /^<OFX\s*>([^]*)<\/OFX\s*>$/i.exec(root)?.[1];
    if (root === undefined || /<\/?OFX\b|<!--|<!\[CDATA\[/i.test(root))
      return invalid;

    const signon =
      /^\s*<SIGNONMSGSRSV1\s*>\s*<SONRS\s*>\s*<STATUS\s*>([^]*?)<\/STATUS\s*>([^]*?)<\/SONRS\s*>\s*<\/SIGNONMSGSRSV1\s*>/i.exec(root);
    if (signon) {
      const status = ofxStatus(signon[1]);
      if (!status.ok) return status;
      const fields = signon[2]
        .replace(
          /<FI\s*>(?:\s*<(ORG|FID)\s*>[^<]*(?:<\/\1\s*>)?)*\s*<\/FI\s*>/i,
          "",
        )
        .replace(
          /<(DTSERVER|USERKEY|TSKEYEXPIRE|LANGUAGE|DTPROFUP|DTACCTUP|SESSCOOKIE|INTU\.BID)\s*>[^<]*(?:<\/\1\s*>)?/gi,
          "",
        );
      if (fields.trim()) return invalid;
      root = root.slice(signon[0].length);
      if (!root.trim()) return noStatement;
    }
    root = root.trim();

    const statements = [...root.matchAll(/<(STMTRS|CCSTMTRS)\s*>/gi)];
    const messageSets =
      root.match(/<(?:CREDITCARDMSGSRSV1|BANKMSGSRSV1)\s*>/gi) ?? [];
    const responses = root.match(/<(?:CCSTMTTRNRS|STMTTRNRS)\s*>/gi) ?? [];
    if (statements.length > 1 || messageSets.length > 1 || responses.length > 1)
      return { ok: false, reason: "multiple-statements" };

    const card =
      /^<CREDITCARDMSGSRSV1\s*>\s*<CCSTMTTRNRS\s*>([^]*?)<\/CCSTMTTRNRS\s*>\s*<\/CREDITCARDMSGSRSV1\s*>$/i.exec(root);
    const deposit =
      /^<BANKMSGSRSV1\s*>\s*<STMTTRNRS\s*>([^]*?)<\/STMTTRNRS\s*>\s*<\/BANKMSGSRSV1\s*>$/i.exec(root);
    const response = (card ?? deposit)?.[1];
    if (response === undefined) return invalid;
    const responseHeader =
      /^\s*(?:<TRNUID\s*>[^<]*(?:<\/TRNUID\s*>)?\s*)?<STATUS\s*>([^]*?)<\/STATUS\s*>\s*(?:<CLTCOOKIE\s*>[^<]*(?:<\/CLTCOOKIE\s*>)?)?/i.exec(response);
    if (!responseHeader) return invalid;
    const status = ofxStatus(responseHeader[1]);
    if (!status.ok) return status;
    const family = card ? "card" : "deposit";
    if (expectedFamily !== undefined && expectedFamily !== family)
      return { ok: false, reason: "wrong-family" };

    const content = response.slice(responseHeader[0].length).trim();
    if (!content) return noStatement;
    if (/<\/?STATUS\b/i.test(content)) return invalid;
    const statement =
      family === "card"
        ? /^<CCSTMTRS\s*>([^]*?)<\/CCSTMTRS\s*>$/i.exec(content)
        : /^<STMTRS\s*>([^]*?)<\/STMTRS\s*>$/i.exec(content);
    const statementTags = root.match(/<\/?(?:CCSTMTRS|STMTRS)\b[^>]*>/gi) ?? [];
    if (!statement || statementTags.length !== 2) return invalid;

    const body = statement[1];
    const account =
      family === "card"
        ? /^\s*<CURDEF\s*>\s*[A-Z]{3}\s*(?:<\/CURDEF\s*>)?\s*<CCACCTFROM\s*>([^]*?)<\/CCACCTFROM\s*>/i
        : /^\s*<CURDEF\s*>\s*[A-Z]{3}\s*(?:<\/CURDEF\s*>)?\s*<BANKACCTFROM\s*>([^]*?)<\/BANKACCTFROM\s*>/i;
    const accountMatch = account.exec(body);
    if (!accountMatch) return invalid;
    const ids = root.match(/<ACCTID\s*>/gi) ?? [];
    const accountId =
      /<ACCTID\s*>([^<]*)/i.exec(accountMatch[1])?.[1].trim() ?? "";
    const suffix = /^(?:[0-9Xx*]+-|[0-9Xx*]*)(\d{4})$/.exec(accountId)?.[1];
    if (
      ids.length !== 1 ||
      !suffix ||
      (expectedLast4 !== undefined && suffix !== expectedLast4)
    )
      return { ok: false, reason: "wrong-account" };

    const activity = body.slice(accountMatch[0].length);
    const list = /^\s*<BANKTRANLIST\s*>([^]*?)<\/BANKTRANLIST\s*>/i.exec(activity);
    const listTags = body.match(/<\/?BANKTRANLIST\b[^>]*>/gi) ?? [];
    if (listTags.length && (listTags.length !== 2 || !list)) return invalid;
    const transactionList = (list?.[1] ?? "").replace(
      /^\s*<DTSTART\s*>[^<]+(?:<\/DTSTART\s*>)?\s*<DTEND\s*>[^<]+(?:<\/DTEND\s*>)?/i,
      "",
    );
    const transactionPattern = /<STMTTRN\s*>([^]*?)<\/STMTTRN\s*>/gi;
    const transactions = [...transactionList.matchAll(transactionPattern)];
    const transactionTags = root.match(/<\/?STMTTRN\b[^>]*>/gi) ?? [];
    if (
      transactions.length * 2 !== transactionTags.length ||
      transactionList.replace(transactionPattern, "").trim()
    )
      return invalid;
    const dates = transactions.map(([, transaction]) =>
      ofxPostedDate(transaction),
    );
    if (dates.some((date) => !validDate(date))) return invalid;
    const remainder = activity
      .slice(list?.[0].length ?? 0)
      .replace(
        /<(LEDGERBAL|AVAILBAL)\s*>(?:\s*<(BALAMT|DTASOF)\s*>[^<]*(?:<\/\2\s*>)?)*\s*<\/\1\s*>/gi,
        "",
      )
      .replace(/<MKTGINFO\s*>[^<]*(?:<\/MKTGINFO\s*>)?/i, "");
    if (remainder.trim()) return invalid;
    if (
      !dates.some(
        (date) =>
          (from === undefined || date >= from) &&
          (to === undefined || date <= to),
      )
    )
      return { ok: false, reason: "no-transactions" };
    return { ok: true };
  }

  async function hashAccountKey(id, salt) {
    const bytes = new TextEncoder().encode(`${salt}${id}`);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function storagePrefix(id) {
    return `bgfin.userscript.${id}.v1.`;
  }

  function createDateMemory(
    { id, legacyDatePrefix },
    getStorage = () => localStorage,
    locks = globalThis.navigator?.locks,
  ) {
    const prefix = `${storagePrefix(id)}date.`;

    function readCheckpoint(storage, key, migrate = false) {
      const current = storage.getItem(prefix + key);
      if (!legacyDatePrefix) return current;
      const legacy = storage.getItem(legacyDatePrefix + key);
      if (!validDate(legacy) || (validDate(current) && current >= legacy))
        return current;
      if (migrate) {
        try {
          storage.setItem(prefix + key, legacy);
        } catch {
          // Use the saved date even if storage is full.
        }
      }
      return legacy;
    }

    async function read(key) {
      const readDate = (migrate) => {
        try {
          return readCheckpoint(getStorage(), key, migrate);
        } catch {
          return null;
        }
      };
      if (locks) {
        try {
          return await locks.request(prefix + key, () => readDate(true));
        } catch {
          // Fall back to a read-only lookup if locking is denied.
        }
      }
      return readDate(false);
    }

    async function save(key, date) {
      if (!locks) return false;
      try {
        await locks.request(prefix + key, () => {
          const storage = getStorage();
          const prior = readCheckpoint(storage, key);
          if (!validDate(prior) || prior < date) storage.setItem(prefix + key, date);
        });
        return true;
      } catch {
        return false;
      }
    }

    return { read, save };
  }

  function mountPanel(adapter) {
    const {
      id, label, origins, formats, delayMs = 700, retryOnRequestFailure = true,
    } = adapter;
    const format = formats[0];
    const prefix = storagePrefix(id);

    function onReadyPage() {
      return (
        window.top === window &&
        origins.includes(location.origin) &&
        adapter.isReadyPage(location)
      );
    }

    if (!onReadyPage()) return;
    const dateMemory = createDateMemory(adapter);

    function isActive(visit) {
      return !visit.aborted && onReadyPage();
    }

    function context(visit) {
      return {
        signal: visit,
        request({ path, ...options }) {
          if (!isActive(visit)) throw new Error("Export page is inactive.");
          const target = new URL(path, location.origin);
          if (target.origin !== location.origin)
            throw new Error("Export request must use the page origin.");
          return fetch(target, {
            ...options,
            mode: "same-origin",
            credentials: "same-origin",
            redirect: "error",
            cache: "no-store",
            signal: AbortSignal.any([visit, AbortSignal.timeout(30_000)]),
          });
        },
      };
    }

    async function getExport(account, from, to, visit) {
      const ctx = context(visit);
      const token = adapter.getSessionToken
        ? await adapter.getSessionToken(ctx, account)
        : undefined;
      const response = await ctx.request(
        adapter.buildDownloadRequest(account, from, to, token),
      );
      const blob = await response.blob();
      const result = adapter.validateResponse(await blob.text(), account, from, to);
      if (!response.ok && result.reason !== "status-error")
        throw new Error("Export request failed.");
      return result.ok ? { ...result, blob } : result;
    }

    function downloadBlob(blob, name) {
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
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
      return new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    function validationMessage({ reason, code }) {
      switch (reason) {
        case "no-statement":
        case "no-transactions":
          return "No transactions in this date range.";
        case "status-error":
          return `${label} returned an error (code ${code}). No file was sent.`;
        case "wrong-family":
        case "wrong-account":
          return `${label} returned a different account or account type. No file was sent.`;
        case "multiple-statements":
          return `${label} returned multiple statements. No file was sent.`;
        default:
          return `${label} did not return a valid ${format}. No file was sent.`;
      }
    }

    async function downloadOne(row, from, to, visit) {
      row.save.hidden = true;
      row.pendingEnd = null;
      const failure =
        `Download failed. Check the ${label} session and date range. No file was sent.`;
      const attempts = retryOnRequestFailure ? 2 : 1;
      for (let attempt = 0; attempt < attempts && isActive(visit); attempt += 1) {
        let result;
        try {
          result = await getExport(row.account, from, to, visit);
        } catch {
          if (isActive(visit)) showDebug("An export attempt failed.");
          if (attempt + 1 < attempts && isActive(visit)) await delay();
          continue;
        }
        if (!isActive(visit)) break;
        if (!result.ok) return validationMessage(result);
        try {
          downloadBlob(result.blob, adapter.filename(row.account, from, to));
        } catch {
          return failure;
        }
        row.pendingEnd = to;
        row.save.hidden = false;
        return `Check Downloads for the file covering ${from} to ${to}.`;
      }
      return failure;
    }

    function element(tag, text) {
      const node = document.createElement(tag);
      if (text) node.textContent = text;
      return node;
    }

    function button(text) {
      const node = element("button", text);
      node.type = "button";
      return node;
    }

    function dateField(text, rangeDate, today) {
      const label = element("label", text);
      const input = element("input");
      input.type = "date";
      input.max = today;
      input.value = rangeDate;
      label.append(input);
      return { label, input };
    }

    const host = element("div");
    const shadow = host.attachShadow({ mode: "closed" });
    const styles = new CSSStyleSheet();
    styles.replaceSync(`
      :host { position: fixed; z-index: 10000; right: 1rem; bottom: 1rem; font: 15px/1.45 system-ui, sans-serif;
        color: #172a3b; color-scheme: light; }
      *, *::before, *::after { box-sizing: border-box; }
      details { background: #fff; border: 1px solid #a6b8c8; border-radius: .6rem; box-shadow: 0 4px 18px #112b4526; }
      summary { background: #064b83; color: #fff; font-weight: 650; cursor: pointer; padding: .65rem .9rem; border-radius: .5rem; }
      details[open] > summary { padding-right: 6rem; }
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
      .refresh { position: absolute; top: .34rem; right: .55rem; padding: .25rem .55rem; background: #064b83; color: #fff; border-color: #c1ddf0; }
      .refresh:focus-visible { outline-color: #fff; }
      details:not([open]) + .refresh { display: none; }
      .save { margin-left: .4rem; }
      :focus-visible { outline: 2px solid #1670b8; outline-offset: 2px; }
      summary:focus-visible { outline-offset: -4px; outline-color: #fff; }
      p { margin: .45rem 0 .65rem; font-size: .88rem; }
      p:empty { display: none; }
      article:last-child { padding-bottom: 0; }
    `);
    shadow.adoptedStyleSheets = [styles];
    const disclosure = element("details");
    const panel = element("section");
    const refresh = button("Refresh");
    refresh.className = "refresh";
    refresh.setAttribute("aria-label", `Refresh ${label} accounts`);
    const allButton = button("Download all");
    allButton.className = "primary";
    allButton.hidden = true;
    const status = element("p");
    status.setAttribute("role", "status");
    const fields = element("fieldset");
    const debugStatus = element("p");
    panel.append(allButton, status, debugStatus, fields);
    disclosure.append(element("summary", `${label} ${format}`), panel);
    shadow.append(disclosure, refresh);
    document.body.append(host);

    const rows = [];
    let loading = false;
    let loaded = false;
    let busy = false;
    let dashboardVisit = new AbortController();

    function showDebug(message) {
      try {
        if (localStorage.getItem(`${prefix}debug`) === "1")
          debugStatus.textContent = `Debug: ${message}`;
      } catch {
        // The panel still works when storage is blocked.
      }
    }

    function resetPanel() {
      dashboardVisit.abort();
      loading = loaded = false;
      rows.length = 0;
      allButton.hidden = true;
      status.textContent = "";
      debugStatus.textContent = "";
      fields.replaceChildren();
    }

    function syncPanelVisibility() {
      host.hidden = !onReadyPage();
      if (host.hidden) {
        resetPanel();
        disclosure.open = false;
      } else if (dashboardVisit.signal.aborted) {
        dashboardVisit = new AbortController();
      }
    }

    async function run(selected) {
      const visit = dashboardVisit.signal;
      if (busy || !isActive(visit)) return;
      const requests = selected.map((row) => ({
        row,
        from: row.from.value,
        to: row.to.value,
      }));
      busy = allButton.disabled = fields.disabled = refresh.disabled = true;
      status.textContent = `Requesting ${format} downloads…`;
      debugStatus.textContent = "";
      try {
        await navigator.locks.request(
          adapter.legacyDatePrefix ?? prefix,
          { ifAvailable: true },
          async (lock) => {
            if (!isActive(visit)) return;
            if (!lock) {
              status.textContent =
                `A ${label} ${format} download is running in another tab.`;
              return;
            }
            let index = 0;
            const today = localToday();
            for (const { row, from, to } of requests) {
              if (!isActive(visit)) break;
              if (!validRange(from, to) || to > today) {
                row.confirmation = null;
                row.status.textContent =
                  "Choose a valid date range ending today or earlier.";
                continue;
              }
              if (index++ > 0) await delay();
              if (!isActive(visit)) break;
              row.confirmation = null;
              row.status.textContent = `Requesting ${format}…`;
              row.status.textContent = await downloadOne(row, from, to, visit);
            }
            if (isActive(visit)) status.textContent = "";
          },
        );
      } catch {
        if (isActive(visit))
          status.textContent =
            `Could not start the download. Reload the ${label} dashboard and try again.`;
      } finally {
        busy = allButton.disabled = fields.disabled = refresh.disabled = false;
      }
    }

    async function makeRow(account, today) {
      const range = defaultRange(today, await dateMemory.read(account.key));
      const from = dateField("Start date", range.from, today);
      const to = dateField("End date", range.to, today);
      const dates = element("div");
      dates.className = "dates";
      dates.append(from.label, to.label);
      const action = button(`Download ${format}`);
      action.setAttribute("aria-label", `Download ${format} for ${account.label}`);
      const status = element("p");
      status.setAttribute("role", "status");
      const save = button("Confirm file saved");
      save.className = "save";
      save.hidden = true;
      save.setAttribute("aria-label", `Confirm file saved for ${account.label}`);
      const row = {
        account,
        from: from.input,
        to: to.input,
        status,
        save,
        pendingEnd: null,
        confirmation: null,
      };
      action.addEventListener("click", () => void run([row]));
      save.addEventListener("click", async () => {
        if (!onReadyPage() || !row.pendingEnd) return;
        const end = row.pendingEnd;
        row.pendingEnd = null;
        save.hidden = true;
        const confirmation = dateMemory.save(account.key, end);
        row.confirmation = confirmation;
        const saved = await confirmation;
        if (row.confirmation !== confirmation) return;
        row.confirmation = null;
        status.textContent = saved
          ? "Download date recorded."
          : "Date storage is unavailable.";
      });
      const article = element("article");
      article.append(element("h2", account.label), dates, action, save, status);
      return { row, article };
    }

    async function loadAccounts() {
      const visit = dashboardVisit.signal;
      if (!isActive(visit) || !disclosure.open || loaded || loading) return;
      loading = true;
      status.textContent = `Loading ${label} accounts…`;
      debugStatus.textContent = "";
      try {
        const accounts = await adapter.listAccounts(context(visit));
        if (!isActive(visit) || !disclosure.open) return;
        const today = localToday();
        const entries = await Promise.all(
          accounts.map((account) => makeRow(account, today)),
        );
        if (!isActive(visit) || !disclosure.open) return;
        for (const { row, article } of entries) {
          rows.push(row);
          fields.append(article);
        }
        allButton.hidden = rows.length === 0;
        status.textContent = rows.length
          ? ""
          : (adapter.emptyAccountsMessage ?? `${label} returned no eligible accounts.`);
        loaded = rows.length > 0;
      } catch {
        if (isActive(visit)) {
          status.textContent =
            `Could not load accounts. Check the ${label} session, then select Refresh.`;
          showDebug("Account lookup failed.");
        }
      } finally {
        if (dashboardVisit.signal === visit) loading = false;
      }
    }

    refresh.addEventListener("click", () => {
      if (busy || !onReadyPage() || !disclosure.open) return;
      resetPanel();
      dashboardVisit = new AbortController();
      void loadAccounts();
    });
    allButton.addEventListener("click", () => void run(rows));
    disclosure.addEventListener("toggle", () => void loadAccounts());
    window.navigation?.addEventListener("currententrychange", syncPanelVisibility);
    window.addEventListener("popstate", syncPanelVisibility);
  }
