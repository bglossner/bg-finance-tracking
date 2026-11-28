// ==UserScript==
// @name         TODO Bank export downloads
// @description  TODO Describe the export format and dashboard.
// @version      0.1.0
// TODO Add an exact HTTPS @match for each supported dashboard.
// @grant        none
// @noframes
// @run-at       document-idle
// ==/UserScript==

  const adapter = {
    id: "todo",
    label: "TODO",
    origins: [], // TODO Add the exact HTTPS origins from the capture.
    formats: [], // TODO Set the export format, e.g. ["QFX"] or ["CSV"].
    isReadyPage(location) {
      // TODO Check the observed dashboard route.
      return false;
    },
    async listAccounts(ctx) {
      // TODO Use ctx.request and return masked, eligible accounts with a stable key.
      throw new Error("Account lookup is unimplemented.");
    },
    async getSessionToken(ctx, account) {
      // TODO Read the fresh session token. Remove this hook if none is needed.
      throw new Error("Session token lookup is unimplemented.");
    },
    buildDownloadRequest(account, from, to, token) {
      // TODO Build the observed same-origin request.
      throw new Error("Export request is unimplemented.");
    },
    validateResponse(text, account, from, to) {
      // TODO Validate identity, dates and format. For QFX, start with validateOfx.
      throw new Error("Export validation is unimplemented.");
    },
    filename(account, from, to) {
      // TODO Match the importer glob using masked routing fields.
      throw new Error("Export filename is unimplemented.");
    },
  };

  if (typeof window !== "undefined") mountPanel(adapter);
