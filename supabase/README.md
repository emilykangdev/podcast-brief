# Supabase Schema

Put all database schema changes in `supabase/migrations/` as versioned SQL files.

- One file per change set (for example: `YYYYMMDDHHMMSS_description.sql`)
- Never rely on one-off SQL in the Dashboard for production schema history
- Apply migrations in order

Current baseline migration:

- `migrations/20260307132000_init_profiles.sql`

# Overall tables 

- Profiles
- Briefs
    - Input (text). This is expected to be a URL
    - Output (text). This is the generated brief
    - ProfileId (uuid). This is the id of the user who owns this brief
    - Status (string). This is the status of the brief. It can be "pending", "generating", "complete", "error"
    - Error (text). This is the error message if the brief failed to generate.