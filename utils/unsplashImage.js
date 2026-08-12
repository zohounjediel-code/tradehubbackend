// utils/unsplashImage.js
// -----------------------------------------------------------------------
// Récupère une vraie photo (libre de droits) correspondant à un mot-clé,
// via l'API officielle d'Unsplash. Nécessite une clé API gratuite
// (voir backend/.env.example pour comment l'obtenir).
//
// Si la clé n'est pas configurée, ou si l'appel échoue pour une raison ou
// une autre (réseau, quota dépassé, aucun résultat...), la fonction
// renvoie `null` -- à charge de l'appelant d'utiliser une image de secours
// (voir placeholderImage() dans database.js).
// -----------------------------------------------------------------------

const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY;

async function fetchUnsplashImage(query) {
  if (!UNSPLASH_ACCESS_KEY) return null;

  try {
    const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=1&orientation=squarish&content_filter=high`;
    const res = await fetch(url, {
      headers: { Authorization: `Client-ID ${UNSPLASH_ACCESS_KEY}` },
    });

    if (!res.ok) {
      console.warn(`Unsplash: réponse ${res.status} pour "${query}", aucune image utilisée pour ce produit.`);
      return null;
    }

    const data = await res.json();
    const photo = data.results?.[0];
    return photo ? photo.urls.regular : null;
  } catch (err) {
    console.warn(`Unsplash: échec de la requête pour "${query}" (${err.message}), aucune image utilisée pour ce produit.`);
    return null;
  }
}

module.exports = { fetchUnsplashImage, isUnsplashConfigured: () => !!UNSPLASH_ACCESS_KEY };
