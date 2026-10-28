import { NextResponse } from "next/server";

import { route } from "@/server/http";
import { requireUser } from "@/server/auth/guards";
import { getDashboardData } from "@/server/services/dashboard";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requireUser();
  return NextResponse.json(await getDashboardData());
});
