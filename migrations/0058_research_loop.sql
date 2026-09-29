-- Research remains outside the KB until corroborated evidence is accepted.
CREATE TABLE research_jobs (
    id UUID PRIMARY KEY,
    kb_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
    requested_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    request_id UUID NOT NULL,
    query TEXT NOT NULL,
    query_key TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'QUEUED' CHECK (state IN (
      'QUEUED','PLANNING','SEARCHING','CRAWLING','EXTRACTING','VALIDATING',
      'ENTITY_RESOLUTION','READY_FOR_INGESTION','INGESTING','REQUERYING',
      'COMPLETED','FAILED','PARTIAL')),
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    sources_discovered INT NOT NULL DEFAULT 0,
    sources_accepted INT NOT NULL DEFAULT 0,
    sources_rejected INT NOT NULL DEFAULT 0,
    duplicates INT NOT NULL DEFAULT 0,
    ingested_documents INT NOT NULL DEFAULT 0,
    document_ids UUID[] NOT NULL DEFAULT '{}',
    coverage JSONB,
    model_used TEXT,
    usage JSONB,
    UNIQUE (kb_id, requested_by, request_id)
);
CREATE UNIQUE INDEX research_one_active_query ON research_jobs(kb_id, query_key)
  WHERE state NOT IN ('COMPLETED','FAILED','PARTIAL');
CREATE INDEX research_jobs_conversation ON research_jobs(kb_id, conversation_id, created_at DESC);
CREATE TABLE research_findings (
    id UUID PRIMARY KEY,
    job_id UUID NOT NULL REFERENCES research_jobs(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    published_at TEXT,
    tier INT NOT NULL,
    raw_text TEXT NOT NULL,
    claim JSONB NOT NULL,
    quotes JSONB NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('accepted','rejected','duplicate')),
    reason TEXT NOT NULL,
    document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX research_findings_job ON research_findings(job_id);
CREATE UNIQUE INDEX research_finding_once ON research_findings(job_id,url,md5(claim->>'text'));
