# Resume GPT Builder (Chrome Extension)

This extension injects a selected profile's resume prompt + JD into your already-open ChatGPT tab, then saves files and can append a row to Google Sheets.

## What it does

- Pick a resume profile (built-in or ones you add in the UI)
- Fill job title, company name, JD link, and JD text
- Saves into `Downloads / [output folder] / [company name - job title] /`:
  - `jd.txt`
  - `Steven_Resume.json` (structured resume content from ChatGPT)
  - `Steven_Resume.html` (rendered locally from that JSON)
  - `Steven_Resume.pdf` (printed from the HTML)
  - `Cover Letter.pdf` (generated next via the **CoverLetter** prompt)
- **Copy row for spreadsheet** — copies a tab-separated row to paste into Google Sheets
- Optionally appends to Google Sheets via Apps Script

## Setup

1. Copy `.env.example` to `.env` and set `OPENAI_API_KEY=sk-...`
   Optional: `OPENAI_MODEL=gpt-4o-mini` (this is the default).
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked**
5. Select this extension folder
6. After changing `.env`, click **Reload** on the extension card

## Use

1. Open `https://chatgpt.com` and make sure you are logged in
2. Click the extension icon
3. Select a **Profile** (e.g. **Steven Avon (Salesforce)**)
4. Fill **Job title**, **Company name**, and **JD link**
5. Paste the JD
6. Set **Output directory**
7. Click **Send to Open ChatGPT Tab**
8. Wait for resume + cover letter PDFs (status updates in the popup)

If ChatGPT already shows the resume JSON but files were not saved, fill the job fields and click **Finish from current ChatGPT reply**.

## Scrape an open job page (no CSV / sheet needed)

When you open a job posting directly (e.g. a Dice or Jobright job page), you don't have to
copy/paste the details:

1. Open the job posting in a normal browser tab.
2. Open the extension panel and click **Scrape open job page**.
3. Job title, company, JD link, and the full job description are filled in for you
   (plus work model, employment type, salary, and posted date for the sheet row).
4. The extension then **generates** (resume only, or resume + cover letter) and runs **Auto Apply**
   automatically through multi-step forms (Next/Continue until the final Submit page, then stops).
   Check **generate only resume** to skip the cover letter and save tokens. Ensure output folder
   and profile are set first.

Supported detection:

- **Dice** (`dice.com`) — works on `/job-detail/{id}` and the search side panel
  (`/jobs?…&selectedJobId=`). Reads the on-page JD module and/or fetches the
  detail page JSON-LD when the SERP panel has no schema.org block.
- **Jobright** (`jobright.ai`) — reads the embedded `__NEXT_DATA__` job payload.
- **Generic fallback** — any site that embeds a schema.org `JobPosting` block
  (many boards / ATS do). More sites are added over time.

To add another site, append an entry to the `JOB_SCRAPERS` registry in
`content/autofill.js` with a hostname matcher and a `scrape()` that returns
`{ jobTitle, companyName, jdLink, jdText, ... }`.

## Auto Apply (multi-step, any site)

**Auto Apply** works like the Jobright autofill extension, on any ATS (Greenhouse, Lever,
Workday, Dice, Jobright, etc.):

1. Detect / open the application form (Easy Apply, Apply, or linked apply URL). When the
   rule-based finder recognises no Apply / Next button, AI reads the page's buttons and picks
   the one that starts or continues the application. It never picks sign-in, social import,
   cookie, or Submit buttons.
2. Upload the resume / cover letter, and fill identity, contact and location fields from the
   **profile**.
3. **Read the whole step**: every empty field — its type (text, textarea, dropdown, radio,
   checkbox, searchable list), label, section, required flag, and the exact list of options.
4. **AI answers every field in one pass** from the profile's **knowledge base**, the closest
   **Q&A bank** answers, the **resume**, and the **job description**. A dropdown / radio answer
   must be one of the real options. Follow-up fields an answer reveals ("If yes, explain") are
   read and answered too.
5. If the page has **Next / Continue / Review** and not a final **Submit**, click it and wait
   for the next step (same-tab SPA, full navigation, iframe, or new tab), then repeat.
6. Stop at **Submit** so you can review and click Submit yourself (Dice submits automatically).

Use the panel button **Apply** or **Alt+Shift+E**. Imported-job Apply and **Scrape open job
page** use the same flow.

### Knowledge base (per profile)

The Q&A bank holds the candidate's own answers, worded the way each form asked. AI distills
the bank — answers you typed, edited, or imported, never answers the AI guessed — plus the
profile info into **one fact per topic**, with conflicts resolved (newest answer wins). Any
wording of the same question is then answered from that fact.

- It re-learns on its own whenever the Q&A bank or profile changes.
- See it, or force a re-learn, in **Q&A bank → Knowledge base**.
- Answers the AI had to guess go to **Needs answers** in the Q&A bank. Confirm one once and
  it becomes a fact for every later application.

Untick **AI reads the whole form** (panel → Learn mode) to go back to the old behaviour:
Q&A bank first, then AI one question at a time. That path is also the automatic fallback
when the AI form reader fails.

## Cost (GPT-4o-mini)

Resume and cover letter use **gpt-4o-mini**. Form fill uses the form model
(`OPENAI_FORM_MODEL`, default **gpt-4o-mini**): one call per application step to read and
answer the whole form, plus one short call whenever a profile's knowledge base re-learns.
Untick **AI reads the whole form** to go back to bank-first filling, which makes no form-fill
call at all when the Q&A bank already knows every answer.

Approximate USD (list prices; your bill may differ — the form-fill figure is an estimate for
one to three ~6k-token steps):

| Phase | Previous default (gpt-4o, 2-pass autofill) | Now (mini, AI reads the whole form) |
|-------|--------------------------------------------|-------------------------------------|
| Resume + cover letter | ~$0.11 | ~$0.007 |
| Form fill | ~$0.15 | ~$0.004 |
| **Typical full job** | **~$0.26** | **~$0.01** |

After generate or Auto Apply, the panel status includes a line like:

`Filled 12 from profile, 8 from Q&A bank, 2 via AI. This job ~$0.008 (legacy ~$0.26, saved ~$0.25).`

## CoverLetter prompt

Built-in file: `prompts/cover-letter.js` (profile title: **CoverLetter**).

It runs automatically after JD + resume are saved. Supports placeholders:

- `{JD}`
- `{JOB_TITLE}`
- `{COMPANY}`

To override without editing the file: add a custom profile named **CoverLetter** (that one is used instead).

## Google Spreadsheet (one-time)

Chrome cannot write to a spreadsheet from the share/edit link alone. You need a tiny Apps Script web app once:

1. Open your spreadsheet
2. **Extensions → Apps Script**
3. In the extension popup, click **Copy Apps Script** (or open `apps-script/Code.gs`)
4. Paste into Apps Script → **Save**
5. **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
6. Authorize when prompted
7. Copy the **Web App URL** into the extension with the spreadsheet link

The spreadsheet URL's `gid` selects the sheet tab. After a resume is generated, the extension
appends a row as:
`No | Created Date | Title | Company | Link | Salary | JD | Apply Status`
(Salary looks like `$120000 - $150000`; JD is left blank). Duplicate checks use the **Link**
column through the same web app.

If you update the Apps Script later, use **Deploy → Manage deployments → Edit → New version**.
Saving the script alone does not update an existing Web App deployment.

## Auto-capture Dice + Jobright (every 4 hours)

This extension integrates with the sibling project **`dice-jobright-sf-job-capture`**.

1. In `dice-jobright-sf-job-capture`, start the local API:
   ```bash
   npm start
   ```
   (Listens on `http://127.0.0.1:3847` by default.)

2. Configure your **Google Sheet** in this extension (spreadsheet URL + Apps Script web app URL).
   The **Link** column is used to skip jobs you've already tracked.

3. Open the extension panel → **Imported** sidebar:
   - **Auto-capture every 4h** — runs while Chrome is open (JobRight via your login; Dice via the capture API).
   - **Capture now** — manual run.
   - Filter list: **All / Dice / Jobright / LinkedIn / Others**.

New jobs are merged into the **Imported** list (extension storage — no CSV import step). Jobs whose URL is already in the **Link** column of your tracking sheet are skipped (“already on sheet”). Jobright also skips jobs you already applied to on Jobright.

After each run (manual or every 4h), the panel shows a summary like:

`Found 45 jobs (Jobright 23, Dice 22). Added 42 (Jobright 20, Dice 22). 3 already on sheet.`

Scheduled captures also show a Chrome notification with the same summary.

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| **Alt+J** | Open extension panel |
| **Alt+Shift+S** | Scrape open job → generate → Auto Apply |
| **Alt+Shift+G** | Generate resume (& cover letter unless “generate only resume” is checked) |
| **Alt+Shift+E** | Auto Apply on current page (any ATS; stops before Submit) |
| **Ctrl+Enter** | Generate (while panel is focused) |

Chrome allows at most **4** extension shortcuts (including Open). Autofill is click-only in the panel.

Rebind anytime at `chrome://extensions/shortcuts` if a shortcut conflicts on your machine.
(`Ctrl+Shift+G` conflicts with Chrome “Find previous”; `Ctrl+Shift+L` / `Win+L`-style combos are unreliable.)

**Requirements**
- **Jobright**: logged into [jobright.ai](https://jobright.ai) in Chrome.
- **Dice**: capture server running (`npm start` in the capture project). Dice uses Playwright on the server side.

## Notes

- Keep ChatGPT tab open while it runs (resume and cover letter each start a new chat).
- Resume flow expects **JSON** from ChatGPT; the extension parses it and renders HTML/PDF locally.
- Output path is relative to Chrome's **Downloads** folder.
- After code changes, click **Reload** on the extension card in `chrome://extensions`.
- Salesforce prompt source: `prompts/steven-avon-resume.txt` (also shipped as built-in profile via `prompts/steven-avon.js`).
