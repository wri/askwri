"use client";

import { Heading, Box, List } from "@chakra-ui/react";
import { ProgressBar, Tag } from "@worldresources/wri-design-systems";
import { FaInfoCircle } from "react-icons/fa";
import { AiIcon } from "../components/icons/AiIcon";
import Navbar from "./Navbar";
import ResultsTable from "./ResultsTable";
import { RowData } from "./types";
import "../styles.css";

const data: RowData[] = Array(100)
  .fill(0)
  .map((_, i) => ({
    id: i,
    publication_name: `Publication name`,
    author: `WRI ${i + 1}`,
    summary: `Lorem ipsum dolor sit amet consectetur. Duis vehicula odio quis id pharetra id nisi.`,
    relevance: i > 5 ? "High" : "Low",
    how_relevant: `Lorem ipsum dolor sit amet consectetur. Duis vehicula odio quis id pharetra id nisi.`,
  }));

const ResultsPage = () => (
  <main className="gradient-background">
    <Navbar />
    <section style={{ padding: "0 2rem", maxWidth: "800px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          margin: "20px 0px",
        }}
      >
        <AiIcon />
        <Heading size="2xl">Search Summary</Heading>
      </div>
      <div
        style={{
          display: "flex",
          width: "250px",
          alignItems: "center",
          gap: "8px",
          marginBottom: "16px",
        }}
      >
        <div style={{ flexGrow: 1 }}>
          <ProgressBar progress={40} />
        </div>
        <Tag icon={<FaInfoCircle />} label="40% Confidence" variant="info-grey" />
      </div>
      <Heading size="lg">
        Returned results for publications WRI has published on: compact urban
        growth in India.
      </Heading>
      <Box style={{ padding: "1rem 0" }}>
        <List.Root>
          <List.Item>
            Your search reviewed 500 publications and found 12 highly relevant
            and 23 moderately relevant results.
          </List.Item>
          <List.Item>
            Overall confidence is 40% because several sources discuss urban
            growth broadly rather than compact growth in India, with limited
            coverage from the last five years.
          </List.Item>
          <List.Item>
            You can improve your search by including a timeframe, for example
            “between 2019–2025”, and a more specific topic, for example
            interest in policies or outcomes related to compact urban growth
          </List.Item>
        </List.Root>
      </Box>
    </section>
    <ResultsTable data={data} />
  </main>
);

export default ResultsPage;
