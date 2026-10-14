import { blogArticles, type BlogArticle } from './fraandsBlog';
import { BRAND } from './brand';
import type { PublicContent } from './seo/types';
export const BLOG_DATE = '2026-10-14';
export const blogHref = (article: BlogArticle) => `/blog/${article.slug}/`;
export const blogBySlug = (slug: string) => blogArticles.find(article => article.slug === slug);
export const blogCategories = [...new Set(blogArticles.map(article => article.category))];
export const blogContent = (article: BlogArticle): PublicContent => ({
  kind: 'article', key: article.slug, canonicalPath: blogHref(article), title: article.title,
  summary: article.summary, visibility: 'public', publishedAt: BLOG_DATE, modifiedAt: BLOG_DATE,
  image: { url: article.image, alt: article.imageAlt, revision: article.slug },
  breadcrumbs: [{ name: 'Blog', path: '/blog/' }, { name: article.title, path: blogHref(article) }],
  article: { authorName: BRAND.name, section: article.category, keywords: article.tags },
});
export const BLOG_CONTENT: PublicContent = {
  kind: 'collection', key: 'blog', canonicalPath: '/blog/', title: 'Friendship, listening and everyday conversations',
  summary: 'Practical ideas for starting conversations, listening with care, sharing interests and respecting boundaries.',
  visibility: 'public', image: { url: blogArticles[0].image, alt: blogArticles[0].imageAlt, revision: 'blog-2026-10-14' },
};
export function relatedBlogArticles(article: BlogArticle) {
  return [...blogArticles.filter(item => item.slug !== article.slug && item.category === article.category),
    ...blogArticles.filter(item => item.slug !== article.slug && item.category !== article.category)].slice(0, 3);
}
