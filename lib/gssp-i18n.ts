/**
 * File: lib/gssp-i18n.ts
 * Helper to give a page's getServerSideProps the i18n namespaces it needs. 'common' is already
 * loaded app-wide in _app, so most pages don't need this — reach for it when a page needs an
 * EXTRA namespace (e.g. job cards: withI18n(['jobcards'])). Redirects / notFound pass through.
 *
 * Usage:
 *   export const getServerSideProps = withI18n(['jobcards'])(async (ctx) => ({ props: { ... } }));
 */
import type { GetServerSideProps, GetServerSidePropsContext, GetServerSidePropsResult } from 'next';
import { serverSideTranslations } from 'next-i18next/serverSideTranslations';
// @ts-ignore — JS config (no type declarations); shape is the next-i18next UserConfig.
import nextI18NextConfig from '../next-i18next.config';

export function withI18n(namespaces: string[] = []) {
  return (inner?: GetServerSideProps): GetServerSideProps =>
    async (ctx: GetServerSidePropsContext): Promise<GetServerSidePropsResult<any>> => {
      const result: GetServerSidePropsResult<any> = inner ? await inner(ctx) : { props: {} };
      // Only augment a props-bearing result; pass redirect / notFound straight through.
      if (!('props' in result)) return result;
      const locale = ctx.locale || nextI18NextConfig.i18n.defaultLocale;
      const i18n = await serverSideTranslations(locale, ['common', ...namespaces], nextI18NextConfig as any);
      const props = await result.props;
      return { ...result, props: { ...props, ...i18n } };
    };
}
