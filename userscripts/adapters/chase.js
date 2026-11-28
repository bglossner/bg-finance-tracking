// ==UserScript==
// @name         Chase QFX downloads
// @description  Download Chase activity as QFX from the signed-in dashboard.
// @version      1.1.0
// @match        https://secure.chase.com/web/auth/dashboard
// @grant        none
// @noframes
// @run-at       document-idle
// ==/UserScript==

  const origin = "https://secure.chase.com";
  const dashboardPath = "/web/auth/dashboard";
  const listPath = "/svc/rl/accounts/l4/v1/app/data/list";
  const cardPath =
    "/svc/rr/accounts/secure/gateway/credit-card/transactions/inquiry-maintenance/digital-transaction-activity/v1/transaction-activities";
  const depositPath =
    "/svc/rr/accounts/secure/v1/account/activity/download/dda/list";
  const formContentType = "application/x-www-form-urlencoded; charset=UTF-8";
  const accept = "application/json, text/plain, */*";
  const legacyDatePrefix = "bgfin.chase-qfx.v1.";

  function filename(last4, from, to) {
    if (
      typeof last4 !== "string" ||
      !/^\d{4}$/.test(last4) ||
      !validRange(from, to)
    ) {
      throw new Error("Invalid account mask or download dates.");
    }
    return `Chase${last4}_Activity_${from}_${to}.QFX`;
  }

  function accountListRequest() {
    return {
      path: listPath,
      method: "POST",
      headers: { Accept: accept, "Content-Type": formContentType },
    };
  }

  function downloadRequest(account, from, to, token) {
    if (
      !validRange(from, to) ||
      typeof account.id !== "string" ||
      !account.id.trim() ||
      typeof token !== "string" ||
      !token.trim()
    ) {
      throw new Error("Invalid download request.");
    }
    const start = from.replaceAll("-", "");
    const end = to.replaceAll("-", "");
    if (account.family === "card") {
      const query = new URLSearchParams({
        "digital-account-identifier": account.id,
        "start-date": start,
        "end-date": end,
        "account-activity-download-type-code": "QFX",
        csrftoken: token,
        submit: "Submit",
        "eligibility-indicator": "true",
      });
      return {
        path: `${cardPath}?${query}`,
        method: "GET",
        headers: {
          Accept: accept,
          "Content-Type": "application/json; charset=UTF-8",
        },
      };
    }
    if (account.family === "deposit") {
      const body = new URLSearchParams({
        transactionType: "ALL",
        filterTranType: "ALL",
        statementPeriodId: "ALL",
        downloadType: "QFX",
        accountId: account.id,
        dateHi: end,
        dateLo: start,
        csrftoken: token,
        submit: "Submit",
      });
      return {
        path: depositPath,
        method: "POST",
        headers: { "Content-Type": formContentType },
        body: body.toString(),
      };
    }
    throw new Error("Unsupported Chase account type.");
  }

  function maskedSuffix(mask) {
    return typeof mask === "string"
      ? /^[0-9Xx*• -]*(\d{4})$/.exec(mask.trim())?.[1]
      : undefined;
  }

  function maskedLabel(family, detailType, mask) {
    const detail =
      typeof detailType === "string" ? detailType.toUpperCase() : "";
    let label = family === "card" ? "Credit card" : "Deposit account";
    if (family === "deposit" && detail === "CHECKING") label = "Checking";
    if (family === "deposit" && detail === "SAVINGS") label = "Savings";
    const suffix = maskedSuffix(mask);
    return suffix ? `${label} …${suffix}` : label;
  }

  function cacheResponses(payload) {
    return Array.isArray(payload?.cache)
      ? payload.cache.map((entry) => entry?.response)
      : [];
  }

  function readAccounts(payload) {
    const lists = cacheResponses(payload).filter((response) =>
      Array.isArray(response?.accountTiles),
    );
    if (lists.length !== 1 || !Array.isArray(lists[0].personalTileGroups)) {
      throw new Error("Chase account list has an unfamiliar shape.");
    }
    const { accountTiles, personalTileGroups } = lists[0];
    const groups = personalTileGroups.filter(
      (group) => group && typeof group === "object",
    );
    const deposits = new Set(
      groups.flatMap((group) =>
        Array.isArray(group.depositAccountTileIds)
          ? group.depositAccountTileIds
          : [],
      ),
    );
    const cards = new Set(
      groups.flatMap((group) =>
        Array.isArray(group.creditCardAccountTileIds)
          ? group.creditCardAccountTileIds
          : [],
      ),
    );
    const accounts = [];
    const seen = new Set();
    for (const tile of accountTiles) {
      if (
        !tile ||
        tile.unavailable === true ||
        tile.tileDetail?.closed === true ||
        tile.tileDetail?.showActivity === false
      )
        continue;
      const isDeposit = deposits.has(tile.tileId);
      const isCard = cards.has(tile.tileId);
      const { accountId } = tile;
      if (typeof accountId !== "string" && !Number.isFinite(accountId))
        continue;
      const id = String(accountId);
      const last4 = maskedSuffix(tile.mask);
      if (isDeposit === isCard || !id.trim() || !last4 || seen.has(id))
        continue;
      const family = isCard ? "card" : "deposit";
      const label = maskedLabel(family, tile.accountTileDetailType, tile.mask);
      accounts.push({ id, family, last4, label });
      seen.add(id);
    }
    return accounts;
  }

  function readCsrfToken(payload) {
    const tokens = cacheResponses(payload)
      .map((response) => response?.csrfToken)
      .filter((token) => typeof token === "string" && token.trim());
    if (tokens.length !== 1)
      throw new Error("Chase did not supply a session token.");
    return tokens[0];
  }

  function withChaseHeaders(request) {
    if (request.method !== "POST") return request;
    return {
      ...request,
      headers: { "x-jpmc-csrf-token": "NONE", ...request.headers },
    };
  }

  async function getAccountData(ctx) {
    const response = await ctx.request(withChaseHeaders(accountListRequest()));
    if (!response.ok) throw new Error("Chase account list request failed.");
    return response.json();
  }

  const chaseAdapter = {
    id: "chase",
    label: "Chase",
    origins: [origin],
    formats: ["QFX"],
    legacyDatePrefix,
    emptyAccountsMessage: "Chase returned no eligible deposit or credit card accounts.",
    isReadyPage(location) {
      return location.pathname === dashboardPath;
    },
    async listAccounts(ctx) {
      const payload = await getAccountData(ctx);
      const accounts = readAccounts(payload);
      readCsrfToken(payload);
      return Promise.all(accounts.map(async (account) => ({
        ...account,
        key: await hashAccountKey(account.id, legacyDatePrefix),
      })));
    },
    async getSessionToken(ctx, account) {
      const payload = await getAccountData(ctx);
      const current = readAccounts(payload).find(
        (entry) =>
          entry.id === account.id &&
          entry.family === account.family &&
          entry.last4 === account.last4,
      );
      if (!current) throw new Error("Chase account list has changed.");
      return readCsrfToken(payload);
    },
    buildDownloadRequest(account, from, to, token) {
      return withChaseHeaders(downloadRequest(account, from, to, token));
    },
    validateResponse(text, account, from, to) {
      return validateOfx(text, account.family, account.last4, from, to);
    },
    filename(account, from, to) {
      return filename(account.last4, from, to);
    },
  };

  if (typeof window === "undefined") {
    if (typeof module !== "undefined") {
      module.exports = {
        localToday,
        defaultRange,
        validRange,
        filename,
        accountListRequest,
        downloadRequest,
        maskedLabel,
        readAccounts,
        readCsrfToken,
        validateOfx,
        chaseAdapter,
        createDateMemory,
      };
    }
    return;
  }
  mountPanel(chaseAdapter);
