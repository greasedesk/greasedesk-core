/*
  Warnings:

  - A unique constraint covering the columns `[billing_email]` on the table `Group` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "Group_billing_email_key" ON "Group"("billing_email");
