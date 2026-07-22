/**
 * File: pages/cookies.tsx
 * Cookie policy — now rendered from the Content system (slug 'cookies', type legal), not hardcoded.
 * 404s if no published version exists. The consent banner + footers link here; the seeded version stamp
 * ('2026-07-21') is what existing consent records resolve to.
 */
import Seo from '@/components/marketing/Seo';
import SiteChrome from '@/components/marketing/SiteChrome';
import PublicDocument from '@/components/content/PublicDocument';
import { documentPage, type PublicDocProps } from '@/lib/content-page';

export default function CookiePolicyPage(props: PublicDocProps) {
  return (
    <SiteChrome>
      <Seo title={props.title} description="How GreaseDesk uses cookies." path="/cookies" />
      <PublicDocument {...props} />
    </SiteChrome>
  );
}
export const getServerSideProps = documentPage('cookies');
