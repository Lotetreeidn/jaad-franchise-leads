-- JAAD Franchise Leads: initial schema. Migrations are append-only; add new numbered files, never edit applied ones.

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  segment TEXT NOT NULL CHECK (segment IN ('FNB_OPERATOR','MASTER_FRANCHISE','PROPERTY_OWNER')),
  market TEXT NOT NULL CHECK (market IN ('LOCAL','GLOBAL')),
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  country TEXT NOT NULL,
  city TEXT NOT NULL DEFAULT '',
  website TEXT,
  domain TEXT,
  place_kind TEXT,
  outlet_count INTEGER NOT NULL DEFAULT 0,
  brand_count INTEGER NOT NULL DEFAULT 0,
  stage TEXT NOT NULL DEFAULT 'NEW' CHECK (stage IN ('NEW','QUALIFIED','CONTACTED','REPLIED','MEETING','NEGOTIATION','WON','LOST','DISQUALIFIED','DO_NOT_CONTACT')),
  verification TEXT NOT NULL DEFAULT 'PENDING' CHECK (verification IN ('PENDING','VERIFIED','REVIEW','FAILED','NO_WEBSITE','BLOCKED_ROBOTS')),
  quality_score INTEGER NOT NULL DEFAULT 0,
  confidence_score INTEGER NOT NULL DEFAULT 0,
  score_reasons TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL CHECK (source IN ('OSM','CSV','APPLY_FORM','MANUAL')),
  source_ref TEXT,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  verified_at TEXT,
  contacted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS leads_domain_uq ON leads(domain) WHERE domain IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS leads_source_ref_uq ON leads(source, source_ref) WHERE source_ref IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS leads_identity_uq ON leads(name_key, country, city);
CREATE INDEX IF NOT EXISTS leads_stage_idx ON leads(stage, quality_score DESC);
CREATE INDEX IF NOT EXISTS leads_verification_idx ON leads(verification, created_at);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id),
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  source_url TEXT NOT NULL,
  observed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS evidence_lead_idx ON evidence(lead_id);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id),
  kind TEXT NOT NULL CHECK (kind IN ('EMAIL','PHONE','WHATSAPP')),
  value TEXT NOT NULL,
  source_url TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS contacts_uq ON contacts(lead_id, kind, value);

CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  lead_id TEXT,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS activities_lead_idx ON activities(lead_id, created_at);
CREATE INDEX IF NOT EXISTS activities_kind_idx ON activities(kind, created_at);

CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id),
  channel TEXT NOT NULL CHECK (channel IN ('EMAIL','WHATSAPP')),
  language TEXT NOT NULL CHECK (language IN ('id','en')),
  to_value TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','APPROVED','SENDING','SENT','FAILED','CANCELLED')),
  error TEXT,
  provider_id TEXT,
  created_at TEXT NOT NULL,
  approved_at TEXT,
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS drafts_status_idx ON drafts(status, created_at);
CREATE INDEX IF NOT EXISTS drafts_lead_idx ON drafts(lead_id);

CREATE TABLE IF NOT EXISTS inquiries (
  id TEXT PRIMARY KEY,
  lead_id TEXT REFERENCES leads(id),
  company TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL,
  city TEXT NOT NULL DEFAULT '',
  partner_type TEXT NOT NULL,
  capital_range TEXT NOT NULL DEFAULT '',
  has_location TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL,
  consent_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS inquiries_created_idx ON inquiries(created_at);

CREATE TABLE IF NOT EXISTS suppression (
  value TEXT PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS targets (
  id TEXT PRIMARY KEY,
  segment TEXT NOT NULL CHECK (segment IN ('FNB_OPERATOR','MASTER_FRANCHISE','PROPERTY_OWNER')),
  country TEXT NOT NULL,
  city TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS targets_uq ON targets(segment, country, city);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  found INTEGER NOT NULL DEFAULT 0,
  inserted INTEGER NOT NULL DEFAULT 0,
  duplicates INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS runs_started_idx ON runs(started_at);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);
