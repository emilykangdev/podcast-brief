import Link from "next/link";
import { getSEOTags } from "@/libs/seo";
import config from "@/config";

// CHATGPT PROMPT TO GENERATE YOUR PRIVACY POLICY — replace with your own data 👇

// 1. Go to https://chat.openai.com/
// 2. Copy paste bellow
// 3. Replace the data with your own (if needed)
// 4. Paste the answer from ChatGPT directly in the <pre> tag below

// You are an excellent lawyer.

// I need your help to write a simple privacy policy for my website. Here is some context:
// - Website: https://shipfa.st
// - Name: ShipFast
// - Description: A JavaScript code boilerplate to help entrepreneurs launch their startups faster
// - User data collected: name, email and payment information
// - Non-personal data collection: web cookies
// - Purpose of Data Collection: Order processing
// - Data sharing: we do not share the data with any other parties
// - Children's Privacy: we do not collect any data from children
// - Updates to the Privacy Policy: users will be updated by email
// - Contact information: marc@shipfa.st

// Please write a simple privacy policy for my site. Add the current date.  Do not add or explain your reasoning. Answer:

export const metadata = getSEOTags({
  title: `Privacy Policy | ${config.appName}`,
  canonicalUrlRelative: "/privacy-policy",
});

const PrivacyPolicy = () => {
  return (
    <main className="max-w-xl mx-auto">
      <div className="p-5">
        <Link href="/" className="btn btn-ghost">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="w-5 h-5"
          >
            <path
              fillRule="evenodd"
              d="M15 10a.75.75 0 01-.75.75H7.612l2.158 1.96a.75.75 0 11-1.04 1.08l-3.5-3.25a.75.75 0 010-1.08l3.5-3.25a.75.75 0 111.04 1.08L7.612 9.25h6.638A.75.75 0 0115 10z"
              clipRule="evenodd"
            />
          </svg>{" "}
          Back
        </Link>
        <h1 className="text-3xl font-extrabold pb-6">Privacy Policy for {config.appName}</h1>

        <pre className="leading-relaxed whitespace-pre-wrap" style={{ fontFamily: "sans-serif" }}>
          {`Last Updated: March 6, 2026

PodcastBrief (“we,” “our,” or “us”) operates the website https://content-learner.vercel.app/
 and provides a service that delivers detailed briefs of podcast episodes to users by email. This Privacy Policy explains how we collect, use, and protect your information when you use our website and services.

1. Information We Collect

We may collect the following types of information when you use our website or services:

Personal Information

When you place an order or interact with our service, we may collect:

Name

Email address

Payment information

Payment information may be processed through a secure third-party payment processor.

Non-Personal Information

We may automatically collect certain non-personal information through cookies and similar technologies, including:

Browser information

Usage data

Website interaction data

2. How We Use Your Information

We collect and use your information solely for the purpose of operating and delivering our service, including:

Processing and fulfilling orders

Delivering podcast briefs to your email

Managing payments and transactions

Improving website functionality and performance

3. Cookies

Our website may use cookies or similar technologies to enhance your browsing experience and to understand how users interact with the site. You may choose to disable cookies through your browser settings.

4. Data Sharing

We do not sell, rent, or share your personal information with third parties. Information may only be processed by service providers strictly necessary to operate the service, such as payment processing.

5. Data Security

We take reasonable measures to protect your personal information from unauthorized access, misuse, or disclosure. However, no method of transmission over the internet or electronic storage is completely secure.

6. Children's Privacy

Our service is not directed toward children. We do not knowingly collect personal information from individuals under the age of 13.

7. Updates to This Privacy Policy

We may update this Privacy Policy from time to time. If significant changes are made, users will be notified by email.

8. Contact Information

If you have any questions about this Privacy Policy or how your data is handled, please contact:

Email: podcastbrief@emilykang.dev
Service Name: PodcastBrief`}
        </pre>
      </div>
    </main>
  );
};

export default PrivacyPolicy;
