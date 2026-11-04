# Draft privacy policy and terms

**Drafts, not legal advice.** The owner approved publishing both documents. Check them against the actual service, Google requirements and applicable Philippine law. They do not establish Google verification or policy compliance. The served pages are maintained in `src/beta/privacy-page.ts` and `src/beta/terms-page.ts`.

---

# Postmaster privacy policy

Postmaster is a closed-beta email organization service operated by Jose Andres Ofrin in the Philippines. Questions or privacy requests can be sent to [joseofrin@gmail.com](mailto:joseofrin@gmail.com).

## Information Postmaster uses

- **Applications and sign-in:** The beta application collects the email address you submit. Google sign-in provides a verified email address and Google account identifier to identify you and control access. Sign-in uses Google identity permissions, including profile scope; signing in alone does not connect Gmail.
- **Gmail connection:** If you separately authorize Gmail, Postmaster requests the `gmail.modify` permission, which allows it to read and modify Gmail messages and labels. Postmaster stores an encrypted authorization token so it can access Gmail on your behalf.
- **Email and processing data:** After approval and an explicit Start, Postmaster reads messages for classification. It uses information such as the sender, subject, date, message body, labels and whether an unsubscribe header is present. It stores processing information such as message identifiers, sender and subject, classification decisions, settings, activity, usage counts and Gmail history position. Classification results can include a short reason.
- **Service and security data:** Postmaster stores beta applications, approval and access records, configuration, session information, operational events and related security records. The service uses cookies for sign-in and authorization flows.

## How Postmaster uses and shares information

Postmaster uses this information to review beta applications, authenticate users, connect Gmail, organize email according to settings, display activity, enforce access and usage limits, and operate and troubleshoot the service. The synthetic demo uses example data rather than your Gmail.

For messages that need model classification, Postmaster may send the sender, subject, date, whether an unsubscribe header is present, and a limited amount of cleaned message-body text to Microsoft Azure OpenAI. This can happen in dry run as well as live mode. Attachments are not sent to the model. The amount of body text is configurable. Classification can also use rules or cached sender decisions without a model call.

The beta is hosted on Microsoft Azure. Azure OpenAI uses a Global Standard deployment, so model processing may occur outside the region hosting the virtual machine. Google provides authentication and Gmail access, and Microsoft provides hosting and model services. Their handling is also subject to their own terms and policies. Contact the operator if you have questions about these services or where your information is processed.

## Your choices

Gmail authorization is separate from sign-in. Approval and a deliberate Start are required before mailbox processing begins. New configurations default to dry run, which records decisions but does not change Gmail; it can still read messages and send classification data to Azure OpenAI. In live mode, after confirmation, Postmaster may apply labels, star messages, mark messages read or archive them according to your settings. It does not send, draft, delete or unsubscribe from messages.

You can stop processing in the beta dashboard; requests already in flight may finish. You can disconnect Gmail from the Account section, which attempts to revoke the Google grant, or revoke access in your Google Account's third-party connections. Removing the local connection is different: it removes the stored connection but does not revoke access at Google or erase backups.

You may request access to, correction of, or deletion of your personal information by emailing the operator. Requests are subject to identity verification, applicable law and technical limitations. The beta does not currently provide a complete self-service deletion mechanism, and requesting deletion or removing a local connection does not itself guarantee deletion from backups, journals, logs, Google or Microsoft systems.

## Retention and security

Postmaster retains application, configuration, processing and other operational records without a fixed automatic deletion period for all record types. For encrypted Gmail tokens, scheduled cleanup removes eligible pending tokens seven days after consent, denied tokens seven days after denial, and expired tokens seven days after approval expiry. Some exceptions apply, including tokens with an unknown save time or unresolved revocation. Cleanup does not revoke the Google grant or erase backups or database journals.

Gmail tokens are encrypted, and the service uses access controls and HTTPS. This is an experimental beta: security isolation, recovery, backups and monitoring are not fully hardened, and no system can guarantee security. Avoid connecting an account if those limitations are unacceptable to you.

## Changes and contact

This policy may change as the service changes. Material changes to the use of Google user data require appropriate notice and consent before the new use. Contact [joseofrin@gmail.com](mailto:joseofrin@gmail.com) with questions or requests.

---

# Postmaster terms of service

Postmaster is a closed beta operated by Jose Andres Ofrin in the Philippines. Contact [joseofrin@gmail.com](mailto:joseofrin@gmail.com) with questions.

## Using the beta

Access requires approval. You may only connect a Google account you are authorized to use and must comply with applicable law and Google's terms. Do not misuse the service, attempt to access another person's data without permission, or interfere with its operation. The operator may suspend or end beta access or change or discontinue the service.

## Gmail access and your choices

Google sign-in, Gmail consent, approval, configuration and Start are separate steps. The Gmail permission allows broad reading and modification of messages. Once approved and started, Postmaster reads email to classify it and may send limited email information to Azure OpenAI as described in the privacy policy. Dry run does not modify Gmail but still processes message data. Live mode requires confirmation and can apply labels, star messages, mark them read or archive them according to your settings.

You are responsible for reviewing settings and classifications before using live mode. Automated results can be wrong, and changes to Gmail may not always be reversible. Stop processing if you no longer want the service to continue; requests already in flight may finish. You can disconnect or revoke Gmail access as described in the privacy policy.

## Beta limitations

The service is experimental and may be unavailable, contain errors, process messages incorrectly or lose data. Do not rely on it as the only way to manage important email. No availability, accuracy or recovery guarantee is offered. To the extent permitted by applicable law, Postmaster is provided as is, without warranties, and the operator is not liable for losses arising from use of the beta. Nothing in these terms excludes rights or liability that cannot lawfully be excluded.

## Changes and governing law

These terms may change as the beta changes. The laws of the Philippines govern these terms, subject to any mandatory protections applicable to you.
