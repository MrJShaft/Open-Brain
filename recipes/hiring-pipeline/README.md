# Hiring Pipeline

> Track open roles, candidates, and interviews for your own hiring — the employer-side counterpart to the Job Hunt Pipeline extension.

## What It Does

A job search management system built for employers instead of job seekers — open roles, candidates, and interviews, with pipeline analytics your agent can reason across. Where the [Job Hunt Pipeline](../../extensions/job-hunt/) extension tracks *your* applications to other companies, this recipe tracks *candidates applying to you*.

## Prerequisites

- Working Open Brain setup ([guide](../../docs/01-getting-started.md))
- Supabase CLI installed and linked to your project
- **Required reading:** [Row Level Security](../../primitives/rls/) primitive

## Credential Tracker

Copy this block into a text editor and fill it in as you go.

```text
HIRING PIPELINE -- CREDENTIAL TRACKER
--------------------------------------

SUPABASE (from your Open Brain setup)
  Project ref:           ____________
  Secret key:            ____________

MCP SERVER
  Default User ID:       ____________
  MCP Access Key:        ____________  (same key for all extensions/recipes)
  MCP Server URL:        ____________
  MCP Connection URL:    ____________

--------------------------------------
```

## Steps

### 1. Set Up the Database Schema

Run the SQL in `schema.sql` in your Supabase SQL Editor:

```bash
# Navigate to your Supabase project SQL editor
# https://supabase.com/dashboard/project/YOUR_PROJECT_ID/sql/new
```

Copy and paste the contents of `schema.sql` and click Run. This creates three RLS-enabled tables with proper foreign key relationships and cascading deletes.

### 2. Generate Your User ID

If you already have a `DEFAULT_USER_ID` set from another extension or recipe, you can reuse it — skip to step 3.

```bash
# macOS / Linux
uuidgen | tr '[:upper:]' '[:lower:]'
```

```bash
supabase secrets set DEFAULT_USER_ID=your-generated-uuid-here
```

### 3. Deploy the MCP Server

Follow the [Deploy an Edge Function](../../primitives/deploy-edge-function/) guide using these values:

| Setting | Value |
|---------|-------|
| Function name | `hiring-pipeline-mcp` |
| Download path | `recipes/hiring-pipeline` |

### 4. Connect to Your AI

Follow the [Remote MCP Connection](../../primitives/remote-mcp/) guide to connect this recipe to Claude Desktop, ChatGPT, Claude Code, or any other MCP client.

| Setting | Value |
|---------|-------|
| Connector name | `Hiring Pipeline` |
| URL | Your **MCP Connection URL** from the credential tracker |

### 5. Test the Recipe

Try these commands with Claude:

```
Add an open role: Senior AI Engineer, $150k-$200k, posted on LinkedIn
```

```
Add a candidate to the Senior AI Engineer role: Jordan Rivera, sourced from LinkedIn
```

```
Schedule a phone screen interview for Jordan Rivera, tomorrow at 2pm
```

```
Log feedback for Jordan Rivera's phone screen — strong communicator, rate it a 4
```

```
Move Jordan Rivera to the interviewing stage
```

```
Close the Senior AI Engineer role — filled, Jordan Rivera was hired
```

```
Show me my hiring pipeline overview - how many candidates, what stages, upcoming interviews
```

## Available Tools

1. **`add_open_role`** — Add a role you're hiring for (title, url, salary_min, salary_max, requirements, nice_to_haves, notes, status, posted_date, closing_date)
2. **`add_candidate`** — Add a candidate to an open role's pipeline (open_role_id, full_name, email, phone, linkedin_url, source, status, resume_url, applied_date, notes)
3. **`update_candidate_status`** — Move a candidate through the pipeline (candidate_id, status, response_date, notes)
4. **`close_open_role`** — Close a role once it's filled or no longer being hired for (open_role_id, status: filled/cancelled, filled_date, notes)
5. **`schedule_candidate_interview`** — Schedule an interview for a candidate (candidate_id, interview_type, scheduled_at, duration_minutes, interviewer_name, interviewer_title, notes)
6. **`log_interview_notes`** — Add feedback/notes after an interview, update status to completed (interview_id, feedback, rating 1-5)
7. **`get_pipeline_overview`** — Dashboard summary: counts by candidate status, upcoming interviews in next N days. This is your "how's hiring going?" tool.
8. **`get_upcoming_interviews`** — List interviews in the next N days with full role/candidate context

## Expected Outcome

After completing this recipe, you should be able to:

1. Track every role you're hiring for, and close it out once it's filled
2. Move candidates through a pipeline (sourced → screening → interviewing → offer → hired/rejected/withdrew)
3. Schedule and log interviews with detailed notes and ratings
4. Get pipeline analytics: candidates per stage, upcoming interviews, hiring activity

Your agent will be able to answer questions like:
- "Show me my hiring pipeline overview"
- "What interviews do I have this week?"
- "Which candidates are in the interviewing stage for the AI Engineer role?"
- "How many candidates have I sourced vs. how many came in via referral?"

## Troubleshooting

For common issues (connection errors, 401s, deployment problems), see [Common Troubleshooting](../../primitives/troubleshooting/).

**Recipe-specific issues:**

**"Foreign key violation" errors**
- Ensure parent records exist before creating child records (open_role → candidate → interview)
- Verify UUIDs are correct and belong to the same user_id
- Deleting an open role will cascade-delete all related candidates and interviews

**Closing a role doesn't change its candidates' statuses**
- `close_open_role` only updates the role itself. Candidates still in progress keep whatever status they're in — update them individually with `update_candidate_status` (e.g. mark the hire as `hired` and the rest as `rejected`)

## Notes for Contributors

This recipe is the employer-side counterpart to the [Job Hunt Pipeline](../../extensions/job-hunt/) extension, which is written from a job seeker's perspective and is part of the curated extensions learning path. Rather than repurposing that curated extension in place, this ships as a standalone recipe with its own schema:

- `companies` was dropped — you are the employer, so there's no need to track your own company as a row
- `job_postings` became `open_roles` (no `company_id`, since there's only one employer)
- `applications` became `candidates` — many candidates per role instead of one application per posting, with a hirer-side status funnel and a `source` field (inbound/referral/agency/sourced/job-board/other)
- `interviews` became `candidate_interviews`, keyed off `candidates` instead of `applications`
- `job_contacts` and the Professional CRM bridge tool were dropped entirely — no employer-side equivalent is provided in this version
