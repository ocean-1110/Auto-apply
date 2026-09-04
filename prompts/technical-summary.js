/**
 * Extra instructions appended to the resume prompt ONLY when the selected
 * template renders a Technical Summary section (see templates/index.js →
 * templateRequiresTechnicalSummary). Templates without that section never see
 * these rules, so they keep producing the standard schema.
 */
export const TECHNICAL_SUMMARY_PROMPT = `
=== TECHNICAL SUMMARY RULES — HIGH PRIORITY ===

Add a technical_summary section immediately after profile and before skills.

JSON format:
"technical_summary": [
"Technical summary bullet.",
"Technical summary bullet."
]

Generate exactly 6–7 concise, senior-level technical summary bullets tailored to the JD.

Prioritize content in this order:

Tier-1 JD Keywords: Lead with the most important technologies, Salesforce products, architecture capabilities, and engineering requirements from the JD. Use exact ATS-recognizable terms where natural, but do not copy JD sentences.
Industry / Domain Expertise: If the JD emphasizes a domain VERIFIED in Candidate Domain Coverage, include one bullet demonstrating that domain through realistic technology and project context, such as Health Cloud + FHIR/HL7 for healthcare or Financial Services Cloud + lending/integration workflows for financial services. Do not add unsupported industries.
Agentforce / Salesforce AI: When relevant, include one concrete senior-level bullet covering Agentforce agents, topics/instructions/actions, prompt design, grounding, guardrails, Data Cloud context, testing, or production readiness. Keep Agentforce evidence timeline-compatible and primarily tied to recent experience.
Data Cloud / Data 360: When relevant, include one bullet covering practical capabilities such as ingestion, data streams, harmonization, identity resolution, unified profiles, calculated insights, segmentation/activation, and AI/Agentforce data readiness.
DevOps / Production Engineering: Include one bullet showing CI/CD, Salesforce DX, Git, automated testing, deployment strategy, release ownership, sandbox strategy, production troubleshooting, or rollback/release controls when relevant to the JD.
Architecture / Integration: Demonstrate seniority through solution architecture, Apex/LWC/Flow, REST APIs, Platform Events, MuleSoft/middleware, security, scalability, asynchronous processing, or integration reliability based on JD priorities.
Seniority / Scale / Impact: At least one bullet should demonstrate senior-level ownership using realistic project scale, architecture responsibility, complex integrations, data volumes, production releases, multi-org delivery, or measurable business/technical impact already supported by the generated experience.

TECHNICAL SUMMARY QUALITY RULES

Each bullet must summarize a capability that is also defensible through Professional Experience; do not introduce advanced technologies that never appear in Experience.
Make the section a high-value technical snapshot, NOT a duplicate of Skills.
Skills answers “what technologies does the candidate know”; Technical Summary answers “what has this senior candidate actually built, designed, integrated, deployed, or owned.”
Prefer combinations such as technology + implementation context + scale/impact.
Keep each bullet to one sentence and approximately 20–35 words.
Use 6 bullets by default and 7 only when the JD has several distinct Tier-1 requirements.
The first 2–3 bullets should carry the strongest JD match.
Include Agentforce, Data Cloud/Data 360, and DevOps when they are relevant to the JD; do not force them ahead of more important mandatory JD requirements.
Use metrics selectively and only when supported by the generated project evidence.
Do not repeat certifications.
Do not use generic soft-skill bullets.
Do not keyword-stuff.
Do not mirror the JD's wording or ordering.
Preserve realistic Salesforce product timelines.
The final section should make the candidate's JD fit, industry credibility, modern Salesforce expertise, architecture depth, and seniority obvious within 10–15 seconds of recruiter review.

TECHNICAL SUMMARY EVIDENCE GATE

Before finalizing, silently verify:

Are the top Tier-1 JD requirements visible in the first 3 bullets?
Is mandatory VERIFIED industry experience represented with concrete technical context?
Are Agentforce and Data Cloud represented when relevant and timeline-compatible?
Is DevOps/release/production ownership visible when important?
Is architecture/integration depth visible?
Does at least one bullet clearly establish seniority, scale, or ownership?
Can every Technical Summary claim be traced to believable Professional Experience evidence?

If any bullet is merely a Skills-list statement, rewrite it to demonstrate implementation, architecture, ownership, scale, or outcome.
`.trim();
