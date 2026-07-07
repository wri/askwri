import { NextRequest, NextResponse } from 'next/server'
import { requireIdentity } from '../../../../../lib/auth/identity'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// The sample/template CSV — flat column format with DB column names.
// Users download this, fill in their metadata, and upload via /admin/import.
const TEMPLATE_CSV = `file_path,external_id,doi,title,authors,year_published,publication_title,article_type,wri_primary_office,languages,url,date_published,summary,short_summary
2021_sustainable-transport-report_1234.pdf,2021_sustainable-transport-report_1234,https://doi.org/10.46830/wri.tn.21.00001,Sustainable Transport for All: A Global Assessment,"Smith, John; Doe, Jane",2021,WRI Sustainable Transport Report,Working Paper,WRI Ross Center,English,https://www.wri.org/research/sustainable-transport,3/15/2021,This report assesses sustainable transport systems globally...,A global assessment of sustainable transport
,,https://doi.org/10.46830/wri.rp.22.00002,Climate Readiness in Urban Transformation,"Garcia, Maria; Lee, Tom",2022,Climate Readiness Report,Report,WRI Ross Center,"English, Spanish",https://www.wri.org/research/climate-readiness,6/1/2022,This report examines climate readiness in urban areas...,Climate readiness in cities
`

export async function GET(req: NextRequest) {
  const { response } = await requireIdentity(req)
  if (response) return response

  return new NextResponse(TEMPLATE_CSV, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="askwri-import-template.csv"',
    },
  })
}
