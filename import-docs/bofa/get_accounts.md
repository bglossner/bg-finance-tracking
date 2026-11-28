## Producing Keys from Response

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
- `categoryType` -- can be `Banking` or `Credit Cards`
- `adx` is the "account token"/`<ACCOUNT_TOKEN>`
- Last 4 characters of `name` are always the last 4 digits of account number