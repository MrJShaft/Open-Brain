/**
 * Recipe: Hiring Pipeline MCP Server
 *
 * Provides tools for managing employer-side recruiting:
 * - Open role tracking
 * - Candidate pipeline
 * - Interview scheduling and logging
 * - Pipeline analytics and upcoming events
 */

import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";

const app = new Hono();

// Zod schemas for tool inputs
const addOpenRoleSchema = z.object({
  title: z.string().describe("Job title"),
  url: z.string().optional().describe("Job posting URL, if published externally"),
  salary_min: z.number().optional().describe("Minimum salary"),
  salary_max: z.number().optional().describe("Maximum salary"),
  salary_currency: z.string().optional().describe("Currency (default: USD)"),
  requirements: z.array(z.string()).optional().describe("Required qualifications"),
  nice_to_haves: z.array(z.string()).optional().describe("Nice-to-have qualifications"),
  notes: z.string().optional().describe("Notes about the role"),
  status: z.enum(["open", "on_hold", "filled", "cancelled"]).optional().describe("Role status (default: open)"),
  posted_date: z.string().optional().describe("Date posted (YYYY-MM-DD)"),
  closing_date: z.string().optional().describe("Application deadline (YYYY-MM-DD)"),
});

const addCandidateSchema = z.object({
  open_role_id: z.string().describe("Open role ID (UUID)"),
  full_name: z.string().describe("Candidate's full name"),
  email: z.string().optional().describe("Email address"),
  phone: z.string().optional().describe("Phone number"),
  linkedin_url: z.string().optional().describe("LinkedIn profile URL"),
  source: z.enum(["inbound", "referral", "agency", "sourced", "job-board", "other"]).optional().describe("Where this candidate came from"),
  status: z.enum(["sourced", "screening", "interviewing", "offer", "hired", "rejected", "withdrew"]).optional().describe("Candidate status (default: sourced)"),
  resume_url: z.string().optional().describe("Resume URL"),
  applied_date: z.string().optional().describe("Date applied (YYYY-MM-DD)"),
  notes: z.string().optional().describe("Additional notes"),
});

const scheduleCandidateInterviewSchema = z.object({
  candidate_id: z.string().describe("Candidate ID (UUID)"),
  interview_type: z.enum(["phone_screen", "technical", "behavioral", "system_design", "hiring_manager", "team", "final"]).describe("Type of interview"),
  scheduled_at: z.string().optional().describe("Interview date/time (ISO 8601)"),
  duration_minutes: z.number().optional().describe("Expected duration in minutes"),
  interviewer_name: z.string().optional().describe("Interviewer name"),
  interviewer_title: z.string().optional().describe("Interviewer title"),
  notes: z.string().optional().describe("Pre-interview prep notes"),
});

const logInterviewNotesSchema = z.object({
  interview_id: z.string().describe("Interview ID (UUID)"),
  feedback: z.string().optional().describe("Post-interview reflection"),
  rating: z.number().min(1).max(5).optional().describe("Your assessment of how it went (1-5)"),
});

const updateCandidateStatusSchema = z.object({
  candidate_id: z.string().describe("Candidate ID (UUID)"),
  status: z.enum(["sourced", "screening", "interviewing", "offer", "hired", "rejected", "withdrew"]).describe("New candidate status"),
  response_date: z.string().optional().describe("Date of this status change (YYYY-MM-DD)"),
  notes: z.string().optional().describe("Notes about this status change"),
});

const closeOpenRoleSchema = z.object({
  open_role_id: z.string().describe("Open role ID (UUID)"),
  status: z.enum(["filled", "cancelled"]).optional().describe("How the role was closed (default: filled)"),
  filled_date: z.string().optional().describe("Date the role was closed (YYYY-MM-DD, default: today)"),
  notes: z.string().optional().describe("Notes about how the role was closed (e.g. which candidate was hired)"),
});

const getPipelineOverviewSchema = z.object({
  days_ahead: z.number().optional().describe("Number of days to look ahead for interviews (default: 7)"),
});

const getUpcomingInterviewsSchema = z.object({
  days_ahead: z.number().optional().describe("Number of days to look ahead (default: 14)"),
});

// Tool handlers
async function handleAddOpenRole(supabase: any, args: z.infer<typeof addOpenRoleSchema>, userId: string): Promise<string> {
  const {
    title, url, salary_min, salary_max, salary_currency,
    requirements, nice_to_haves, notes, status, posted_date, closing_date
  } = args;

  const { data, error } = await supabase
    .from("open_roles")
    .insert({
      user_id: userId,
      title,
      url: url || null,
      salary_min: salary_min || null,
      salary_max: salary_max || null,
      salary_currency: salary_currency || "USD",
      requirements: requirements || [],
      nice_to_haves: nice_to_haves || [],
      notes: notes || null,
      status: status || "open",
      posted_date: posted_date || null,
      closing_date: closing_date || null,
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to add open role: ${error.message}`);
  }

  return JSON.stringify({
    success: true,
    message: `Added open role: ${title}`,
    open_role: data,
  }, null, 2);
}

async function handleAddCandidate(supabase: any, args: z.infer<typeof addCandidateSchema>, userId: string): Promise<string> {
  const {
    open_role_id, full_name, email, phone, linkedin_url,
    source, status, resume_url, applied_date, notes
  } = args;

  const { data, error } = await supabase
    .from("candidates")
    .insert({
      user_id: userId,
      open_role_id,
      full_name,
      email: email || null,
      phone: phone || null,
      linkedin_url: linkedin_url || null,
      source: source || null,
      status: status || "sourced",
      resume_url: resume_url || null,
      applied_date: applied_date || null,
      notes: notes || null,
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to add candidate: ${error.message}`);
  }

  return JSON.stringify({
    success: true,
    message: `Added candidate: ${full_name}`,
    candidate: data,
  }, null, 2);
}

async function handleUpdateCandidateStatus(supabase: any, args: z.infer<typeof updateCandidateStatusSchema>, userId: string): Promise<string> {
  const { candidate_id, status, response_date, notes } = args;

  const update: Record<string, unknown> = { status };
  if (response_date !== undefined) update.response_date = response_date;
  if (notes !== undefined) update.notes = notes;

  const { data, error } = await supabase
    .from("candidates")
    .update(update)
    .eq("id", candidate_id)
    .eq("user_id", userId)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to update candidate status: ${error.message}`);
  }

  return JSON.stringify({
    success: true,
    message: `Candidate status updated to ${status}`,
    candidate: data,
  }, null, 2);
}

async function handleCloseOpenRole(supabase: any, args: z.infer<typeof closeOpenRoleSchema>, userId: string): Promise<string> {
  const { open_role_id, status, filled_date, notes } = args;
  const resolvedStatus = status || "filled";

  const update: Record<string, unknown> = {
    status: resolvedStatus,
    filled_date: filled_date || new Date().toISOString().slice(0, 10),
  };
  if (notes !== undefined) update.notes = notes;

  const { data, error } = await supabase
    .from("open_roles")
    .update(update)
    .eq("id", open_role_id)
    .eq("user_id", userId)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to close open role: ${error.message}`);
  }

  return JSON.stringify({
    success: true,
    message: `Open role marked as ${resolvedStatus}`,
    open_role: data,
  }, null, 2);
}

async function handleScheduleCandidateInterview(supabase: any, args: z.infer<typeof scheduleCandidateInterviewSchema>, userId: string): Promise<string> {
  const {
    candidate_id, interview_type, scheduled_at, duration_minutes,
    interviewer_name, interviewer_title, notes
  } = args;

  const { data, error } = await supabase
    .from("candidate_interviews")
    .insert({
      user_id: userId,
      candidate_id,
      interview_type,
      scheduled_at: scheduled_at || null,
      duration_minutes: duration_minutes || null,
      interviewer_name: interviewer_name || null,
      interviewer_title: interviewer_title || null,
      status: "scheduled",
      notes: notes || null,
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to schedule interview: ${error.message}`);
  }

  return JSON.stringify({
    success: true,
    message: "Interview scheduled successfully",
    interview: data,
  }, null, 2);
}

async function handleLogInterviewNotes(supabase: any, args: z.infer<typeof logInterviewNotesSchema>, userId: string): Promise<string> {
  const { interview_id, feedback, rating } = args;

  const { data, error } = await supabase
    .from("candidate_interviews")
    .update({
      feedback: feedback || null,
      rating: rating || null,
      status: "completed",
    })
    .eq("id", interview_id)
    .eq("user_id", userId)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to log interview notes: ${error.message}`);
  }

  return JSON.stringify({
    success: true,
    message: "Interview notes logged and status updated to completed",
    interview: data,
  }, null, 2);
}

async function handleGetPipelineOverview(supabase: any, args: z.infer<typeof getPipelineOverviewSchema>, userId: string): Promise<string> {
  const { days_ahead } = args;
  const daysToCheck = days_ahead || 7;

  // Get candidate counts by status
  const { data: candidates, error: candidateError } = await supabase
    .from("candidates")
    .select("status")
    .eq("user_id", userId);

  if (candidateError) {
    throw new Error(`Failed to get candidates: ${candidateError.message}`);
  }

  const statusCounts = candidates.reduce((acc: any, candidate: any) => {
    acc[candidate.status] = (acc[candidate.status] || 0) + 1;
    return acc;
  }, {});

  // Get upcoming interviews
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + daysToCheck);

  const { data: upcomingInterviews, error: interviewError } = await supabase
    .from("candidate_interviews")
    .select(`
      *,
      candidates!inner(
        *,
        open_roles!inner(*)
      )
    `)
    .eq("user_id", userId)
    .eq("status", "scheduled")
    .gte("scheduled_at", new Date().toISOString())
    .lte("scheduled_at", futureDate.toISOString())
    .order("scheduled_at", { ascending: true });

  if (interviewError) {
    throw new Error(`Failed to get upcoming interviews: ${interviewError.message}`);
  }

  return JSON.stringify({
    success: true,
    total_candidates: candidates.length,
    status_breakdown: statusCounts,
    upcoming_interviews_count: upcomingInterviews.length,
    upcoming_interviews: upcomingInterviews,
  }, null, 2);
}

async function handleGetUpcomingInterviews(supabase: any, args: z.infer<typeof getUpcomingInterviewsSchema>, userId: string): Promise<string> {
  const { days_ahead } = args;
  const daysToCheck = days_ahead || 14;

  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + daysToCheck);

  const { data, error } = await supabase
    .from("candidate_interviews")
    .select(`
      *,
      candidates!inner(
        *,
        open_roles!inner(*)
      )
    `)
    .eq("user_id", userId)
    .eq("status", "scheduled")
    .gte("scheduled_at", new Date().toISOString())
    .lte("scheduled_at", futureDate.toISOString())
    .order("scheduled_at", { ascending: true });

  if (error) {
    throw new Error(`Failed to get upcoming interviews: ${error.message}`);
  }

  return JSON.stringify({
    success: true,
    count: data.length,
    interviews: data,
  }, null, 2);
}

// MCP server endpoint
app.post("*", async (c) => {
  // Fix: Claude Desktop connectors don't send the Accept header that
  // StreamableHTTPTransport requires. Build a patched request if missing.
  if (!c.req.header("accept")?.includes("text/event-stream")) {
    const headers = new Headers(c.req.raw.headers);
    headers.set("Accept", "application/json, text/event-stream");
    const patched = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers,
      body: c.req.raw.body,
      // @ts-ignore -- duplex required for streaming body in Deno
      duplex: "half",
    });
    Object.defineProperty(c.req, "raw", { value: patched, writable: true });
  }

  // Validate access key
  const key = c.req.query("key") || c.req.header("x-access-key");
  const expected = Deno.env.get("MCP_ACCESS_KEY");
  if (!key || key !== expected) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Initialize Supabase client
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  );

  const userId = Deno.env.get("DEFAULT_USER_ID");
  if (!userId) {
    return c.json({ error: "DEFAULT_USER_ID not configured" }, 500);
  }

  // Create MCP server
  const server = new McpServer({ name: "hiring-pipeline", version: "1.0.0" });

  // Register tools
  const wrap = async (fn: () => Promise<string>) => {
    try {
      const text = await fn();
      return { content: [{ type: "text" as const, text }] };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: msg }) }], isError: true };
    }
  };

  server.tool(
    "add_open_role",
    "Add a role you are hiring for",
    addOpenRoleSchema.shape,
    async (args) => wrap(() => handleAddOpenRole(supabase, args, userId))
  );

  server.tool(
    "add_candidate",
    "Add a candidate to the pipeline for an open role",
    addCandidateSchema.shape,
    async (args) => wrap(() => handleAddCandidate(supabase, args, userId))
  );

  server.tool(
    "update_candidate_status",
    "Move a candidate through the hiring pipeline (e.g. screening -> interviewing -> offer -> hired/rejected/withdrew)",
    updateCandidateStatusSchema.shape,
    async (args) => wrap(() => handleUpdateCandidateStatus(supabase, args, userId))
  );

  server.tool(
    "close_open_role",
    "Close an open role once it's filled or no longer being hired for",
    closeOpenRoleSchema.shape,
    async (args) => wrap(() => handleCloseOpenRole(supabase, args, userId))
  );

  server.tool(
    "schedule_candidate_interview",
    "Schedule an interview for a candidate",
    scheduleCandidateInterviewSchema.shape,
    async (args) => wrap(() => handleScheduleCandidateInterview(supabase, args, userId))
  );

  server.tool(
    "log_interview_notes",
    "Add feedback/notes after an interview and mark it as completed",
    logInterviewNotesSchema.shape,
    async (args) => wrap(() => handleLogInterviewNotes(supabase, args, userId))
  );

  server.tool(
    "get_pipeline_overview",
    "Get a dashboard summary: candidate counts by status, upcoming interviews, recent activity",
    getPipelineOverviewSchema.shape,
    async (args) => wrap(() => handleGetPipelineOverview(supabase, args, userId))
  );

  server.tool(
    "get_upcoming_interviews",
    "List interviews in the next N days with full role/candidate context",
    getUpcomingInterviewsSchema.shape,
    async (args) => wrap(() => handleGetUpcomingInterviews(supabase, args, userId))
  );

  // Connect transport and handle request
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

// Health check endpoint
app.get("*", (c) => c.json({
  status: "ok",
  service: "Hiring Pipeline",
  version: "1.0.0"
}));

// Start server
Deno.serve(app.fetch);
