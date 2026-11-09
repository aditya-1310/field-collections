# Fieldnote

Fieldnote is a field collections workspace for branch managers and officers. Managers import daily overdue reports, review assignments and track roll rates. Officers see an explainable follow-up order and can record visit outcomes offline.

[Open the live demo](https://fieldnote-collections.onrender.com/)

## Run the demo

```sh
npm ci
npm run dev
```

Open the frontend URL printed by Vite. Local development uses embedded PostgreSQL when `DATABASE_URL` is empty. The first start creates the schema and loads the synthetic dataset.

| Role | Email | Demo password |
| --- | --- | --- |
| Manager | `manager@fieldnote.demo` | `Demo@12345` |
| Officer | `officer@fieldnote.demo` | `Demo@12345` |

Use [the example CSV](fixtures/overdue-loans.csv) to try the import. For offline testing, build with `npm run build` and serve with `npm start` so the service worker is enabled. The app mocks calls, messages and external payment confirmations.

## Project notes

- [Technical design](docs/technical-design.md)
- [Implementation decisions and code references](docs/decisions.md)
- [Priority policy and worked examples](docs/priority-policy-final.md)
- [Deployment instructions](deployment.md)

Run `npm test` for the queue and API integration checks. Tests use an isolated in-memory PostgreSQL instance.
