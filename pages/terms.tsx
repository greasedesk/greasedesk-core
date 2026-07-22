/**
 * File: pages/terms.tsx
 * Terms of Service — rendered from the Content system (slug 'terms', type legal). 404s until published.
 */
import Seo from '@/components/marketing/Seo';
import SiteChrome from '@/components/marketing/SiteChrome';
import PublicDocument from '@/components/content/PublicDocument';
import { documentPage, type PublicDocProps } from '@/lib/content-page';

export default function TermsPage(props: PublicDocProps) {
  return (
    <SiteChrome>
      <Seo title={props.title} description="GreaseDesk terms of service." path="/terms" />
      <PublicDocument {...props} />
    </SiteChrome>
  );
}
export const getServerSideProps = documentPage('terms');
