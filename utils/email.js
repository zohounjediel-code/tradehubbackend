// utils/email.js
// -----------------------------------------------------------------------
// Envoi d'emails transactionnels via Resend (inscription, commande,
// contact). FROM_EMAIL utilise le domaine partagé "onboarding@resend.dev"
// tant qu'aucun domaine propre n'est vérifié dans Resend -- ça fonctionne
// immédiatement, sans configuration DNS, mais l'expéditeur affiché reste
// générique. Une fois un domaine acheté et vérifié sur resend.com/domains,
// remplacer FROM_EMAIL par ex. "TradeHub <commandes@tondomaine.com>".
//
// Toute erreur d'envoi est avalée (log + retour silencieux) : un email qui
// échoue ne doit jamais faire échouer une inscription ou une commande.
// -----------------------------------------------------------------------

const { Resend } = require('resend');

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM_EMAIL = process.env.EMAIL_FROM || 'TradeHub <onboarding@resend.dev>';
const ADMIN_NOTIFICATION_EMAIL = process.env.ADMIN_NOTIFICATION_EMAIL || 't6535875@gmail.com';

async function sendEmail({ to, subject, html }) {
  if (!resend) {
    console.warn(`RESEND_API_KEY absent : email "${subject}" à ${to} non envoyé.`);
    return;
  }
  try {
    const { error } = await resend.emails.send({ from: FROM_EMAIL, to, subject, html });
    if (error) console.warn(`Échec envoi email "${subject}" à ${to} :`, error.message || error);
  } catch (err) {
    console.warn(`Échec envoi email "${subject}" à ${to} :`, err.message);
  }
}

// Gabarit HTML commun (logo texte + couleurs de la marque) pour que les 4
// types d'email partagent la même identité visuelle.
function emailLayout(title, bodyHtml) {
  return `
    <div style="font-family: Arial, Helvetica, sans-serif; max-width: 560px; margin: 0 auto; color: #1f2937;">
      <div style="background: #0f1b2d; padding: 20px 24px;">
        <span style="font-size: 20px; font-weight: 800; color: #ffffff;">Trade<span style="color: #e8590c;">Hub</span></span>
      </div>
      <div style="padding: 28px 24px; background: #ffffff;">
        <h1 style="font-size: 18px; margin: 0 0 16px;">${title}</h1>
        ${bodyHtml}
      </div>
      <div style="padding: 16px 24px; color: #9ca3af; font-size: 12px;">
        © ${new Date().getFullYear()} TradeHub — Projet de démonstration à but pédagogique.
      </div>
    </div>
  `;
}

function money(n) {
  return `${Number(n).toFixed(2)} €`;
}

// Les valeurs interpolées ci-dessous (nom, message...) viennent de saisies
// utilisateur -- échappées pour ne pas casser le HTML de l'email ni
// permettre d'y injecter des balises.
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// --- Bienvenue à l'inscription (client) ---
async function sendCustomerWelcomeEmail(customer) {
  const html = emailLayout('Bienvenue sur TradeHub !', `
    <p>Bonjour ${escapeHtml(customer.firstName)},</p>
    <p>Ton compte client TradeHub est prêt. Tu peux dès maintenant parcourir le catalogue et commander en gros auprès de nos fournisseurs vérifiés.</p>
    <p style="margin-top: 24px;">
      <a href="https://tradehubfrontend.vercel.app" style="background: #e8590c; color: #ffffff; padding: 12px 20px; border-radius: 6px; text-decoration: none; font-weight: 600;">Découvrir le catalogue</a>
    </p>
  `);
  await sendEmail({ to: customer.email, subject: 'Bienvenue sur TradeHub', html });
}

// --- Confirmation de commande (client) ---
async function sendOrderConfirmationEmail({ customer, orderId, items, total, address }) {
  const itemsHtml = items.map((it) => `
    <tr>
      <td style="padding: 6px 0; border-bottom: 1px solid #f0f0f0;">${escapeHtml(it.product_name)} × ${it.quantity}</td>
      <td style="padding: 6px 0; border-bottom: 1px solid #f0f0f0; text-align: right;">${money(it.unit_price * it.quantity)}</td>
    </tr>
  `).join('');

  const html = emailLayout(`Commande #${String(orderId).padStart(6, '0')} confirmée`, `
    <p>Bonjour ${escapeHtml(customer.name)},</p>
    <p>Ta commande a bien été enregistrée. Voici le récapitulatif :</p>
    <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">${itemsHtml}</table>
    <p style="font-weight: 700; font-size: 16px;">Total : ${money(total)}</p>
    <p style="color: #6b7280; font-size: 13px;">Livraison : ${escapeHtml(address)}</p>
    <p style="margin-top: 16px;">Les instructions de paiement (RIB des fournisseurs) sont disponibles sur la page de confirmation de commande.</p>
  `);
  await sendEmail({ to: customer.email, subject: `Confirmation de ta commande #${String(orderId).padStart(6, '0')}`, html });
}

// --- Nouvelle commande (boutique) ---
async function sendShopNewOrderEmail({ shopEmail, shopName, orderId, items, subtotal, customerName, address }) {
  const itemsHtml = items.map((it) => `
    <tr>
      <td style="padding: 6px 0; border-bottom: 1px solid #f0f0f0;">${escapeHtml(it.product_name)} × ${it.quantity}</td>
      <td style="padding: 6px 0; border-bottom: 1px solid #f0f0f0; text-align: right;">${money(it.unit_price * it.quantity)}</td>
    </tr>
  `).join('');

  const html = emailLayout('Nouvelle commande reçue', `
    <p>Bonjour ${escapeHtml(shopName)},</p>
    <p>Tu as reçu une nouvelle commande (#${String(orderId).padStart(6, '0')}) sur TradeHub :</p>
    <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">${itemsHtml}</table>
    <p style="font-weight: 700; font-size: 16px;">Montant pour toi : ${money(subtotal)}</p>
    <p style="color: #6b7280; font-size: 13px;">Client : ${escapeHtml(customerName)}<br/>Livraison : ${escapeHtml(address)}</p>
    <p style="margin-top: 16px;">Retrouve le détail complet et le suivi de paiement dans ton espace vendeur.</p>
  `);
  await sendEmail({ to: shopEmail, subject: `Nouvelle commande #${String(orderId).padStart(6, '0')}`, html });
}

// --- Message de contact reçu (admin) ---
async function sendContactNotificationEmail({ name, email, message }) {
  const html = emailLayout('Nouveau message de contact', `
    <p><strong>De :</strong> ${escapeHtml(name)} (${escapeHtml(email)})</p>
    <p style="white-space: pre-wrap; background: #f9fafb; padding: 12px; border-radius: 6px;">${escapeHtml(message)}</p>
  `);
  await sendEmail({ to: ADMIN_NOTIFICATION_EMAIL, subject: `Nouveau message de contact de ${name}`, html });
}

module.exports = {
  sendCustomerWelcomeEmail,
  sendOrderConfirmationEmail,
  sendShopNewOrderEmail,
  sendContactNotificationEmail,
};
