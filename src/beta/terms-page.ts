import {
  PUBLIC_DOCUMENT_FOOTER,
  PUBLIC_DOCUMENT_HEADER,
  PUBLIC_DOCUMENT_STYLE,
} from './public-style.js';

/** Public terms for the closed beta. */
export const TERMS_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Postmaster terms of service</title><style>${PUBLIC_DOCUMENT_STYLE}</style></head><body>${PUBLIC_DOCUMENT_HEADER}<main class="document">
<div class="document-heading"><span class="eyebrow">The details · Terms</span><h1>Postmaster terms of service</h1></div>
<p>Postmaster is a closed beta operated by Jose Andres Ofrin in the Philippines. Contact <a href="mailto:joseofrin@gmail.com">joseofrin@gmail.com</a> with questions.</p>
<h2>Using the beta</h2>
<p>Access requires approval. You may only connect a Google account you are authorized to use and must comply with applicable law and Google's terms. Do not misuse the service, attempt to access another person's data without permission, or interfere with its operation. The operator may suspend or end beta access or change or discontinue the service.</p>
<h2>Gmail access and your choices</h2>
<p>Google sign-in, Gmail consent, approval, configuration and Start are separate steps. The Gmail permission allows broad reading and modification of messages. Once approved and started, Postmaster reads email to classify it and may send limited email information to Azure OpenAI as described in the <a href="/privacy">privacy policy</a>. Dry run does not modify Gmail but still processes message data. Live mode requires confirmation and can apply labels, star messages, mark them read or archive them according to your settings.</p>
<p>You are responsible for reviewing settings and classifications before using live mode. Automated results can be wrong, and changes to Gmail may not always be reversible. Stop processing if you no longer want the service to continue; requests already in flight may finish. You can disconnect or revoke Gmail access as described in the privacy policy.</p>
<h2>Beta limitations</h2>
<p>The service is experimental and may be unavailable, contain errors, process messages incorrectly or lose data. Do not rely on it as the only way to manage important email. No availability, accuracy or recovery guarantee is offered. To the extent permitted by applicable law, Postmaster is provided as is, without warranties, and the operator is not liable for losses arising from use of the beta. Nothing in these terms excludes rights or liability that cannot lawfully be excluded.</p>
<h2>Changes and governing law</h2>
<p>These terms may change as the beta changes. The laws of the Philippines govern these terms, subject to any mandatory protections applicable to you.</p>
</main>${PUBLIC_DOCUMENT_FOOTER}</body></html>`;
