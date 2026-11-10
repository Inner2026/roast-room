# Put The Executive Room online

You need two things: an **Anthropic API key** and a **host**. Your Claude Pro subscription does not cover the API; the API is billed per use at console.anthropic.com. Typical cost per board session is a few cents to under a dollar, depending on models and web searches (each search is billed separately). The app has a daily spend cap (`GLOBAL_DAILY_BUDGET_USD`) based on its own estimate. Also set a spending limit in the Anthropic console.

## Steps (Render, the simplest)
1. console.anthropic.com: create an account, add credit, create an API key. Keep it secret; never paste it in GitHub or chat.
2. render.com: sign up, New > Blueprint, connect the GitHub repo `Inner2026/roast-room`. It reads `render.yaml`.
3. When asked, fill the environment variables:
   - `ANTHROPIC_API_KEY`: your key
   - `ALLOWED_EMAILS`: your email (only invited emails can create accounts; leave empty to open to everyone)
4. Deploy. Render gives you an `https://...onrender.com` address. Open it, create your account with the allowed email.
5. The disk mounted at `/data` holds the database (accounts and saved sessions). Without a disk, data is lost on redeploy.

## Any other host
Run the Dockerfile, or `node --no-warnings app/web.js` on Node 22.5 or newer. Put it behind HTTPS (required: cookies are `Secure` in production). Set `NODE_ENV=production`, `TRUST_PROXY=1` when behind a proxy, and `DATABASE_FILE` to persistent storage.

## Try it free first
`LLM_PROVIDER=mock npm run web` shows the whole site with placeholder answers and spends nothing.

## What is NOT included
- Email verification and password reset (use `ALLOWED_EMAILS` to keep it private).
- Payments / paid plans (plan limits live in `config/plans.json`; set a user's `plan` in the database by hand).
- Multiple server instances (runs and live streams are held in one process's memory; use one instance).
- Per-user business memory or profiles.
- A live test against the real Anthropic API has not been run by the author: the adapter is tested against a local fake of the documented API. Watch the first real session and report errors.
