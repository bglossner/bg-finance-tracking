# Chase QFX downloads on Windows

## Install in Tampermonkey

1. Install Tampermonkey from the browser's extension store. Use its Chrome, Edge, or Firefox release. [Tampermonkey downloads](https://www.tampermonkey.net/)
2. Open **Tampermonkey → Create a new script**. Replace the editor contents with the entire [Chase QFX userscript](chase-qfx-download.user.js) and save with **Ctrl+S**. Check that the script is enabled. If Chrome or Edge shows an **Allow User Scripts** toggle for Tampermonkey under the extension's details, turn it on.
3. Glossner signs in to Chase personally, completing any verification in the browser. Open or reload the signed-in accounts dashboard and select **Chase QFX** at the lower right. The script uses the existing page session and starts account lookup when glossner opens the panel.

## Download activity

- Each row shows the account type and its last four digits. Set the **Start date** and **End date** for each account. On first use the panel starts 30 days ago. On a new dashboard load it starts three days before the most recent end date confirmed for that account. The end date defaults to today.
- For an initial import, set the start to the history cutoff from the Windows guide. For regular imports, check the importer’s next export date as well. It tracks imported transactions, while the panel tracks requested download coverage.
- Use **Download QFX** for one account or **Download all** for each row’s dates in sequence. Each failed request gets one retry. Check the browser’s download list for every expected file, then select **Confirm file saved** for each completed file. Chrome or Edge may ask whether Chase can save multiple files. If a file is missing or the browser canceled it, repeat that account’s date range before confirming.
- Files go to the browser’s normal download location, usually Windows **Downloads**, or the folder chosen in the browser prompt. Move only finished `.QFX` files into the private WSL importer inbox using the copy and rename steps in [Windows setup, section 6](../WINDOWS_SETUP.md#6-drop-chase-exports-weekly). The `Chase<last4>_Activity_<start>_<end>.QFX` names fit the Windows template’s `ChaseXXXX_Activity*.[qQ][fF][xX]` globs after setting each account’s last four digits in the private mapping.

The script stores only end dates in Chase-origin browser local storage under keys derived from SHA-256 hashes of account IDs. Reload the dashboard to see updated defaults. The script requests a fresh session token from Chase for each download attempt and uses it in that request. Files are handed to the browser locally.

## If Chase changes its site

An absent panel after a dashboard reload, an account-loading error, or an invalid-QFX message can indicate a dashboard or endpoint change. Confirm the script is enabled and the Chase session is active. The panel also rejects a file if its account suffix is missing or differs from the selected account. Check whether Chase's built-in **Activity** download still offers **Quicken Web Connect (QFX)** for the same account and range. The built-in download also works with the Windows handoff above.

The acquisition research found that Chase documents approved, consented access for third-party tools. This userscript uses Chase's dashboard requests in glossner's own session after glossner signs in. Glossner can review Chase's current terms before deciding whether to enable it. [Chase Digital Services Agreement](https://static.chasecdn.com/content/dam/legal-agreements/library/en/dsa_la/versions/dsa_la.pdf#page=12)
