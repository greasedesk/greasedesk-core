/**
 * File: pages/[slug].tsx
 * THE public renderer for any Content-system document — a single dynamic route so a document created in
 * the Engine Room gets a working URL at /<slug> with NO code change or deploy. Explicit marketing pages
 * (/pricing, /contact, /reseller, /register, …) are their own files and take precedence; this catches
 * document slugs (e.g. /cookies, /privacy, /terms) and 404s anything with no published version.
 */
import Seo from '@/components/marketing/Seo';
import SiteChrome from '@/components/marketing/SiteChrome';
import PublicDocument from '@/components/content/PublicDocument';
import { documentPageDynamic, type PublicDocProps } from '@/lib/content-page';

export default function DocumentPage(props: PublicDocProps) {
  return (
    <SiteChrome>
      <Seo title={props.title} description={props.title} path={`/${props.slug}`} />
      <PublicDocument {...props} />
    </SiteChrome>
  );
}
export const getServerSideProps = documentPageDynamic;
