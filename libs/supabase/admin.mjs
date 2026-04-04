// Server-side Supabase admin client using SUPABASE_SECRET_KEY.
// Use this for all server/script code. For Next.js cookie-based auth, use libs/supabase/server.js.
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  {
    auth: { persistSession: false },
  }
);

export default supabase;
