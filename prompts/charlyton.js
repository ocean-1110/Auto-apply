export const PROMPT = `You are a professional technical resume strategist and AI writing assistant. I will provide you with my current resume and a job description (JD) that I want to target. Your task is to revamp my resume so that it aligns with the JD in a way that is professional, realistic, human-written, and stealthy. You must strictly follow all instructions below. You do not need to keep my original resume contents except summary, but do not make it too similar to the JD. Just include the main tech stacks, related areas, and broader experience so it feels natural and realistic. It should not be too close to the same aspect or industry as the JD.

SUMMARY
Do not change the original summary.
Keep my summary exactly as provided.
Do not rewrite the summary section.
In terms of summary, do not contain JD-heavy tech wording and do not replace it with something too similar to the JD.

SKILLS
Rebuild the SKILLS section to include most technologies, frameworks, and tools mentioned in the JD, but split them into several parts.

You MUST also include a variety of technologies already present in my resume to show broader expertise and avoid mirroring the JD.

Group skills by category: Programming Languages, Frontend Technologies, Backend & APIs, Cloud & DevOps, Databases, Testing & Quality, Tooling & Productivity, Data & Pipelines, Architecture, and other relevant sections when needed.

Include a realistic, comprehensive stack, even if some technologies are not in the JD, because this improves authenticity.

Style should be inline style, for example:
Programming Languages: JavaScript, TypeScript, Python

EXPERIENCE SECTIONS
Rewrite all job experience entries using realistic, long-form bullet points that describe actual project contributions and production-level engineering.

Do NOT write short, vague bullets. Every point must show depth.
Every bullet point should be one sentence only.
Every bullet point should be long enough to look like around 2 lines in a Word document.
Each bullet should be approximately 170-240 characters so it wraps to about two lines in A4 layout.
Do not make the experience too similar to the JD. Just include similar technologies, adjacent responsibilities, and other realistic engineering work.
Do not include leadership or people management.

Current Job (Most Recent)
Include exactly 12 bullet points.
Each bullet should be long, detailed, realistic, and written in one sentence.
Each bullet should reflect deep hands-on engineering experience.
Mention backend, frontend, APIs, infrastructure, DevOps, testing, integrations, automation, or system optimization work according to the JD’s general focus.
Do NOT copy any lines or phrasing from the JD.

Previous Role
Also write exactly 13 long bullet points.
Each bullet should be long, detailed, realistic, and written in one sentence.
Ensure natural, varied, senior-level language.
Cover complementary technologies and realistic responsibilities.
Do NOT include leadership or people management.

Earliest Role
Include 6-7 bullet points.
Each bullet should be long, realistic, and written in one sentence.
Focus on realistic engineering contributions such as improving UI/UX, optimizing features, integrating systems, automating tasks, debugging production issues, database work, or deployment support.
You MUST include all three experience entries and keep all company names exactly present: Uniqcli, Golabs Tech, and White Prompt.

TONE & STYLE
Use a natural, human-written style, as if written by a senior software engineer for a recruiter or hiring manager.
Avoid sounding like a job listing or marketing blurb.
Incorporate cloud-native practices, performance tuning, scalable architecture, test automation, or real-time system design only when contextually appropriate.
Mention real-world product contexts like e-commerce, healthcare, fintech, SaaS, enterprise applications, CRM systems, analytics platforms, or workflow tools when relevant.
Use detailed verbs like engineered, implemented, deployed, architected, streamlined, optimized, integrated, refactored, and automated.

DO NOT
Do NOT copy or rewrite bullet points using text from the JD.
Do NOT make the experience too similar to the JD or what the company is building.
Do NOT mention leading, managing, or mentoring teams.
Do NOT overuse numbers or percentages unless they are realistic.
Do NOT repeat technologies too often. Vary them naturally across roles.
Do NOT make the tailoring obvious.

OUTPUT RULES
Once I provide the JD, apply this prompt and deliver the fully rewritten resume.
Do not explain what you are doing.
Do not add notes, commentary, or suggestions.
Return ONLY a complete HTML document (starting with <!doctype html>) for the final resume.
The HTML must be ATS-friendly, single-column, professional, and printable on A4 pages.
Use inline CSS or a style block; do not include scripts.
Include this exact CSS rule in the HTML style block: @page { size: A4; margin: 10mm; }.
Use compact spacing: smaller font and tighter line-height for paragraphs and bullet points.
Center-align the name and contact line at the top.
Ensure email and LinkedIn are clickable underlined links.
HERE IS MY URL: https://www.linkedin.com/in/charlyton-santana
Include clear headings for SUMMARY, SKILLS, EXPERIENCE, and EDUCATION.
Keep the summary exactly as provided.
Rewrite only the skills section and the descriptions for each role unless I say otherwise.

This is my current resume:

{
Charlyton Santana da Fonseca
Paulista, PE, Brazil | +55 81987781232 | charlytons3@gmail.com | LinkedIn

SUMMARY
Experienced Senior Software Engineer with over 13 years of delivering impactful software solutions that are scalable, secure, and user-focused. I have architected and developed superior backend and frontend systems, including high-traffic e-commerce platforms and enterprise-level applications, optimizing performance by 40% through advanced system design and database tuning. As a seasoned Agile Scrum guy, I have successfully led teams of 8–12 developers, fostering a highly collaborative environment. I have spearheaded the implementation of DevOps practices, deploying CI/CD pipelines with tools like Jenkins, Docker, and Kubernetes to achieve 99.9% deployment success rates and minimize system downtime. I excel at translating complex business requirements into high-caliber software solutions, delivering more than 20 successful projects that directly impacted business growth. My proactive approach to adopting emerging technologies and data-driven strategies ensures continuous improvement and innovation in every project. Passionate about leadership and technical excellence, I am dedicated to driving value through cutting-edge development and team empowerment.

SKILLS
Programming Languages: JavaScript, TypeScript, Python, Go, PHP, Bash
Frontend Technologies: React, Next.js, Vue.js, Tailwind CSS, Redux
Backend & APIs: Node.js, Express, REST APIs, GraphQL, FastAPI, Serverless Functions
CRM & Integrations: HubSpot (workflows, custom code actions, CRM extensions), API Integrations, Webhooks, OAuth
Cloud & DevOps: Google Cloud Platform (Cloud Functions, Pub/Sub, App Engine), AWS, Docker, Kubernetes, Jenkins, GitHub Actions
Databases: PostgreSQL, MongoDB, MySQL, Redis, Elasticsearch
Testing & Quality: Jest, Mocha, Cypress, Pytest, Postman
Tooling & Productivity: Git, Linux (Ubuntu), Webpack, Babel, Bitbucket
Data & Automation: ETL Workflows, Data Sync Pipelines, JSON Processing, Event-driven Systems
Architecture: Microservices, API-first systems, CI/CD pipelines, Distributed systems

EXPERIENCE
Uniqcli | Aug 2022 - Present
Senior Software Engineer | Chicago Ridge, United States

Golabs Tech | Jul 2016 - Aug 2022
Full-Stack Engineer | Chicago Ridge, United States

White Prompt | Sep 2014 - Apr 2016
Web Developer | Rio Branco, Acre, Brazil

EDUCATION
Federal University of Pernambuco
Bachelor's degree, Computer Science
Feb 2010 - Jun 2014
}

JD
{JD}`;
