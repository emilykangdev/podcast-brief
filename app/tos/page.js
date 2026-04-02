import Link from "next/link";
import { getSEOTags } from "@/libs/seo";
import config from "@/config";

// CHATGPT PROMPT TO GENERATE YOUR TERMS & SERVICES — replace with your own data 👇

// 1. Go to https://chat.openai.com/
// 2. Copy paste bellow
// 3. Replace the data with your own (if needed)
// 4. Paste the answer from ChatGPT directly in the <pre> tag below

// You are an excellent lawyer.

// I need your help to write a simple Terms & Services for my website. Here is some context:
// - Website: https://shipfa.st
// - Name: ShipFast
// - Contact information: marc@shipfa.st
// - Description: A JavaScript code boilerplate to help entrepreneurs launch their startups faster
// - Ownership: when buying a package, users can download code to create apps. They own the code but they do not have the right to resell it. They can ask for a full refund within 7 day after the purchase.
// - User data collected: name, email and payment information
// - Non-personal data collection: web cookies
// - Link to privacy-policy: https://shipfa.st/privacy-policy
// - Governing Law: France
// - Updates to the Terms: users will be updated by email

// Please write a simple Terms & Services for my site. Add the current date. Do not add or explain your reasoning. Answer:

export const metadata = getSEOTags({
  title: `Terms and Conditions | ${config.appName}`,
  canonicalUrlRelative: "/tos",
});

const TOS = () => {
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
          </svg>
          Back
        </Link>
        <h1 className="text-3xl font-extrabold pb-6">Terms and Conditions for {config.appName}</h1>

        <pre className="leading-relaxed whitespace-pre-wrap" style={{ fontFamily: "sans-serif" }}>
          {`Last Updated: March 6, 2026

Welcome to PodcastBrief. These Terms of Service (“Terms”) govern your use of the PodcastBrief website and services available at:

https://content-learner.vercel.app/

By accessing or using the service, you agree to be bound by these Terms. If you do not agree with these Terms, please do not use the service.

1. Description of the Service

PodcastBrief provides a service that generates detailed briefs summarizing and explaining podcast episodes. Users may purchase a certain number of briefs and submit podcast content to receive generated briefs delivered to their email inbox.

2. Purchases and Usage

Users may purchase credits for a specified number of briefs. After purchase, users may submit requests for briefs through the service.

Each purchased credit allows the user to request one brief. Once generated and delivered to the user’s email inbox, the user owns the delivered brief.

PodcastBrief reserves the right to refuse or cancel orders if necessary to maintain service integrity or comply with applicable law.

3. Ownership of Generated Briefs

Once a brief is generated and sent to the user’s email address, the user owns the copy of the brief delivered to them.

PodcastBrief retains ownership of the underlying service, website, software, and systems used to generate the briefs.

4. User Responsibilities

By using the service, you agree to:

Provide accurate and truthful information when placing orders

Use the service only for lawful purposes

Not misuse, interfere with, or attempt to disrupt the website or service

5. Third-Party Podcast Content

PodcastBrief generates briefs by processing publicly available podcast audio. Briefs are transformative summaries intended for personal educational use only. You agree not to reproduce, distribute, or publicly republish any brief in a way that substitutes for or competes with the original podcast content.

Raw transcripts of podcast episodes are used solely as an intermediate processing step to generate your brief and are not provided to users.

6. Information We Collect

To provide the service, we collect certain information including:

Name

Email address

Payment information

We may also collect non-personal information such as web cookies to improve website functionality.

For more details about how data is handled, please review our Privacy Policy:

https://content-learner.vercel.app/privacy-policy

7. Payment Processing

Payments may be processed through third-party payment providers. By completing a purchase, you agree to the payment terms and policies of the applicable payment processor.

8. Service Availability

PodcastBrief strives to keep the service available but does not guarantee uninterrupted or error-free operation. The service may be modified, suspended, or discontinued at any time.

9. Limitation of Liability

To the maximum extent permitted by law, PodcastBrief shall not be liable for any indirect, incidental, consequential, or special damages arising from the use or inability to use the service.

The service and generated briefs are provided “as is” without warranties of any kind.

10. Governing Law

These Terms are governed by and interpreted in accordance with the laws of the United States.

11. Updates to These Terms

We may update these Terms from time to time. If material changes are made, users will be notified by email.

12. Contact Information

If you have any questions regarding these Terms, please contact:

PodcastBrief
Email: podcastbrief.support@gmail.com`}
        </pre>
      </div>
    </main>
  );
};

export default TOS;
