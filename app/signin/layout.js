import config from "@/config";
import { getSEOTags } from "@/libs/seo";

export const metadata = getSEOTags({
  title: `Sign in or sign up — ${config.appName}`,
  canonicalUrlRelative: "/auth/signin",
});

export default function Layout({ children }) {
  return <>{children}</>;
}
