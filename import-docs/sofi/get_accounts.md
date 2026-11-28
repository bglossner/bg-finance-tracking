## Get Account Information

```js
const val = [...document.head.querySelectorAll('script')].find((script) => script.innerHTML.trim().startsWith("window.APOLLO_STATE"))
const state = JSON.parse(val.innerHTML.trim().replace("window.APOLLO_STATE=", "").replaceLast(";", ""))
const relevantAccounts = Object.values(state).filter((v) => v.__typename === 'CheckingAccount' || v.__typename === 'SavingsAccount')
const neededAccountData = relevantAccounts.map((account) => ({
    last4: account.accountNumber.slice(-4),
    id: account.id,
    family: 'deposit',
    balance: parseFloat(account.ledgerBalance.unformatted),
}));
```

## CSRF Token

Retrieved from SOFI_CSRF_COOKIE or SOFI_CSRF_COOKIE cookie. Both have same value.