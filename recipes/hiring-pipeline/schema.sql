-- Recipe: Hiring Pipeline
-- Schema for tracking employer-side recruiting: open roles, candidates, interviews

-- Table: open_roles
-- Positions you are hiring for
CREATE TABLE IF NOT EXISTS open_roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    title TEXT NOT NULL,
    url TEXT,
    salary_min INTEGER,
    salary_max INTEGER,
    salary_currency TEXT DEFAULT 'USD',
    requirements TEXT[],
    nice_to_haves TEXT[],
    notes TEXT,
    status TEXT DEFAULT 'open' CHECK (status IN ('open', 'on_hold', 'filled', 'cancelled')),
    posted_date DATE,
    closing_date DATE,
    filled_date DATE,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Upgrade path for databases that ran this schema before filled_date existed
ALTER TABLE open_roles ADD COLUMN IF NOT EXISTS filled_date DATE;

-- Table: candidates
-- People in the running for an open role
CREATE TABLE IF NOT EXISTS candidates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    open_role_id UUID REFERENCES open_roles(id) ON DELETE CASCADE NOT NULL,
    user_id UUID NOT NULL,
    full_name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    linkedin_url TEXT,
    source TEXT CHECK (source IN ('inbound', 'referral', 'agency', 'sourced', 'job-board', 'other') OR source IS NULL),
    status TEXT DEFAULT 'sourced' CHECK (status IN ('sourced', 'screening', 'interviewing', 'offer', 'hired', 'rejected', 'withdrew')),
    resume_url TEXT,
    applied_date DATE,
    response_date DATE,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Table: candidate_interviews
-- Scheduled and completed interviews for a candidate
CREATE TABLE IF NOT EXISTS candidate_interviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE NOT NULL,
    user_id UUID NOT NULL,
    interview_type TEXT CHECK (interview_type IN ('phone_screen', 'technical', 'behavioral', 'system_design', 'hiring_manager', 'team', 'final')),
    scheduled_at TIMESTAMPTZ,
    duration_minutes INTEGER,
    interviewer_name TEXT,
    interviewer_title TEXT,
    status TEXT DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled', 'no_show')),
    notes TEXT, -- pre-interview prep notes
    feedback TEXT, -- post-interview reflection
    rating INTEGER CHECK (rating >= 1 AND rating <= 5 OR rating IS NULL), -- your assessment of how it went
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_open_roles_user_status
    ON open_roles(user_id, status);

CREATE INDEX IF NOT EXISTS idx_candidates_open_role_id
    ON candidates(open_role_id);

CREATE INDEX IF NOT EXISTS idx_candidates_user_status
    ON candidates(user_id, status);

CREATE INDEX IF NOT EXISTS idx_candidate_interviews_candidate_scheduled
    ON candidate_interviews(candidate_id, scheduled_at);

CREATE INDEX IF NOT EXISTS idx_candidate_interviews_user_scheduled
    ON candidate_interviews(user_id, scheduled_at)
    WHERE scheduled_at IS NOT NULL;

-- Row Level Security (RLS)
ALTER TABLE open_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidate_interviews ENABLE ROW LEVEL SECURITY;

-- RLS Policies: Users can only see their own data
CREATE POLICY open_roles_user_policy ON open_roles
    FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY candidates_user_policy ON candidates
    FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY candidate_interviews_user_policy ON candidate_interviews
    FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- Function to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers to update updated_at columns
DROP TRIGGER IF EXISTS update_open_roles_updated_at ON open_roles;
CREATE TRIGGER update_open_roles_updated_at
    BEFORE UPDATE ON open_roles
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_candidates_updated_at ON candidates;
CREATE TRIGGER update_candidates_updated_at
    BEFORE UPDATE ON candidates
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Sample data (optional - uncomment to insert examples)
-- INSERT INTO open_roles (user_id, title, status, salary_min, salary_max) VALUES
-- (auth.uid(), 'Senior AI Engineer', 'open', 150000, 200000);
