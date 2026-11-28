## Getting Statements for Credit Cards

THIS IS NOT REQUIRED FOR BANKING CATEGORY ACCOUNTS.

Load the `https://secure.bankofamerica.com/myaccounts/brain/redirect.go?source=overview&target=acctDetails&request_locale=en-us&adx=<ACCOUNT_TOKEN>` HTML doc page. In it, the statement IDs can be found at:
```
document.querySelectorAll("#select_transaction > option")
```

For a look at them, see `statement-html.data`.

### Why do you need statements?

In order to get transactions, you need the `stx` query parameter. That is the statement ID that you must get from the HTML.

## Getting Banking Transactions

### Producing Keys from Response

Response for text in: https://secure.bankofamerica.com/ogateway/addapi/v1/activity

```js
const fs = require('fs');
const content = fs.readFileSync('<FILE_WITH_FULL_RESPONSE.txt>', 'utf8');

function getAllKeyPaths(jsonString) {
    const obj = JSON.parse(jsonString);
    const paths = [];

    function traverse(value, path) {
        if (value && typeof value === "object") {
            for (const key of Object.keys(value)) {
                const newPath = `${path}.${key}`;
                paths.push(newPath);
                traverse(value[key], newPath);
            }
        }
    }

    traverse(obj, "$");
    return paths;
}

const keys = getAllKeyPaths(JSON.parse(`"${content.trim()}"`))
fs.writeFileSync('out.json', JSON.stringify(val, null, 2), 'utf8');
```

Important format call outs for keys:
- Always just the last some amount of time for `Banking` family
- `formattedAccountNumber` looks like `"xxxxxxxx<LAST_4>"`
- `activityDate` is the start of the downloaded content

Example transaction:
```json
{
  amount: { amount: <VALUE LIKE 2222.22>, displayAmount: '<IGNORE>' },
  status: { value: 'Completed' },
  postedTimestamp: 1795175999000,
  transactionType: { code: '<CODE>' },
  accountIdentifier: {
    productCode: '<IGNORE>',
    productSubCode: '<IGNORE>',
    nickname: '<NAME> - <LAST_4_OF_ACCOUNT_NUMBER>',
    adxid: '<ACCOUNT_TOKEN>'
  },
  preferredDescription: '<DESCRIPTION>',
  spendingCategoryCode: '<IGNORE>',
  displayTypeCode: { code: '<CODE>', value: '<VALUE>' },
  customizedDescription: '<DESCRIPTION>',
  actualRunningBalanceAmount: { amount: <VALUE LIKE 2222.22>, displayAmount: '<IGNORE_THIS>' },
  transactionToken: '<TRANSACTION_TOKEN>',
  statementSeparator: 'Amount included in available balance',
  formattedPostedDate: 'MM/DD/YYYY',
  merchantName: '<MERCHANT>'
}
```