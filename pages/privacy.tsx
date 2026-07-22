/**
 * File: pages/privacy.tsx
 * Privacy policy — rendered from the Content system (slug 'privacy', type legal). 404s until published.
 */
import Seo from '@/components/marketing/Seo';
import SiteChrome from '@/components/marketing/SiteChrome';
import PublicDocument from '@/components/content/PublicDocument';
import { documentPage, type PublicDocProps } from '@/lib/content-page';

export default function PrivacyPage(props: PublicDocProps) {
  return (
    <SiteChrome>
      <Seo title={props.title} description="How GreaseDesk handles your data." path="/privacy" />
      <PublicDocument {...props} />
    </SiteChrome>
  );
}
export const getServerSideProps = documentPage('privacy');
