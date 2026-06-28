-- CreateTable
CREATE TABLE "UserSite" (
    "user_id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,

    CONSTRAINT "UserSite_pkey" PRIMARY KEY ("user_id","site_id")
);

-- CreateIndex
CREATE INDEX "UserSite_site_id_idx" ON "UserSite"("site_id");

-- AddForeignKey
ALTER TABLE "UserSite" ADD CONSTRAINT "UserSite_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSite" ADD CONSTRAINT "UserSite_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
