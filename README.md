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
4. The extension then **generates** (resume only, or resume + cover letter) and runs **Easy Apply**
   automatically (stops before submit). Check **generate only resume** to skip the cover letter
   and save tokens. Ensure output folder and profile are set first.

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
appends JD link, role, company, and date to columns A–D. CSV import reads column A through the
same web app and ignores jobs whose URL is already present.

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
   Column A is used to skip jobs you've already tracked.

3. Open the extension panel → **Imported** sidebar:
   - **Auto-capture every 4h** — runs while Chrome is open (JobRight via your login; Dice via the capture API).
   - **Capture now** — manual run.
   - Filter list: **All / Dice / Jobright / LinkedIn / Others**.

New jobs are merged into the **Imported** list (extension storage — no CSV import step). Jobs whose URL is already in column A of your tracking sheet are skipped (“already on sheet”). Jobright also skips jobs you already applied to on Jobright.

After each run (manual or every 4h), the panel shows a summary like:

`Found 45 jobs (Jobright 23, Dice 22). Added 42 (Jobright 20, Dice 22). 3 already on sheet.`

Scheduled captures also show a Chrome notification with the same summary.

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| **Alt+J** | Open extension panel |
| **Alt+Shift+S** | Scrape open job → generate → Easy Apply |
| **Alt+Shift+G** | Generate resume (& cover letter unless “generate only resume” is checked) |
| **Alt+Shift+E** | Easy Apply on current Dice/Jobright page |
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
