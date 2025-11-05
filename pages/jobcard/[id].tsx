/**
 * File: pages/jobcard/[id].tsx
 * Last edited: 2025-10-27 21:25 Europe/London
 *
 * Job Card view.
 * This is where intake photos / checklist / completion will live.
 * Right now: static placeholder with the structure we want.
 */
import { useRouter } from "next/router";
import Layout from "../../components/Layout";

export default function JobCardPage() {
  const router = useRouter();
  const { id } = router.query;

  // later we'll fetch(`/api/jobcard?id=${id}`)
  return (
    <Layout title={`Job Card #${id || "…"}`}>
      <div className="p-4 grid gap-4 md:grid-cols-3">
        {/* Intake Photos */}
        <section className="bg-gdPanel/60 border border-gdBorder rounded-2xl shadow-card p-4">
          <h2 className="text-gdText font-semibold text-sm mb-2">
            Intake Photos
          </h2>
          <p className="text-gdSubtext text-xs mb-4">
            Front / Left / Rear / Right / Engine Bay / VIN / Mileage
          </p>
          <div className="grid grid-cols-2 gap-3 text-xs text-center text-gdSubtext">
            <div className="border border-gdBorder/60 rounded-xl aspect-video flex items-center justify-center">
              Front
            </div>
            <div className="border border-gdBorder/60 rounded-xl aspect-video flex items-center justify-center">
              Left
            </div>
            <div className="border border-gdBorder/60 rounded-xl aspect-video flex items-center justify-center">
              Rear
            </div>
            <div className="border border-gdBorder/60 rounded-xl aspect-video flex items-center justify-center">
              Right
            </div>
            <div className="border border-gdBorder/60 rounded-xl aspect-video flex items-center justify-center">
              Engine Bay
            </div>
            <div className="border border-gdBorder/60 rounded-xl aspect-video flex items-center justify-center">
              VIN / Mileage
            </div>
          </div>
        </section>

        {/* Work Required */}
        <section className="bg-gdPanel/60 border border-gdBorder rounded-2xl shadow-card p-4 md:col-span-2">
          <h2 className="text-gdText font-semibold text-sm mb-2">
            Work Required
          </h2>
          <p className="text-gdSubtext text-xs mb-4">
            Checklist of tasks for this job. Tick when complete. Add notes for
            parts required.
          </p>

          <div className="space-y-3 text-sm">
            <div className="flex items-start justify-between rounded-xl border border-gdBorder/60 bg-slate-800/30 p-3">
              <div>
                <div className="text-gdText font-medium">
                  Oil service – BMW 520d
                </div>
                <div className="text-gdSubtext text-xs">
                  Drain oil, replace filter, refill LL-04, reset service light.
                </div>
              </div>
              <button className="text-xs bg-gdAccent text-slate-900 font-semibold rounded-lg px-2 py-1 h-fit">
                Mark done
              </button>
            </div>

            <div className="flex items-start justify-between rounded-xl border border-gdBorder/60 bg-slate-800/30 p-3">
              <div>
                <div className="text-gdText font-medium">
                  Brake fluid flush
                </div>
                <div className="text-gdSubtext text-xs">
                  Pressure bleed all four corners, top up, record on sheet.
                </div>
              </div>
              <button className="text-xs bg-gdAccent text-slate-900 font-semibold rounded-lg px-2 py-1 h-fit">
                Mark done
              </button>
            </div>
          </div>

          <div className="mt-4 text-right">
            <button className="inline-block bg-gdAccent text-slate-900 text-xs font-semibold rounded-xl px-3 py-2">
              Job ready for customer
            </button>
          </div>
        </section>
      </div>
    </Layout>
  );
}
