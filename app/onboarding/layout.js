import { createClient } from "@/libs/supabase/server";
import { redirect } from "next/navigation";
import config from "@/config";

export default async function OnboardingLayout({ children }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(config.auth.loginUrl);
  }

  return <>{children}</>;
}
