"use client";

import { useState } from "react";
import { Heading } from "@chakra-ui/react";
import {
  TableRow,
  TableCell,
  Tag,
  Checkbox,
  Button,
} from "@worldresources/wri-design-systems";
import { FaThumbsDown, FaThumbsUp } from "react-icons/fa6";
import { PiDownloadSimpleBold } from "react-icons/pi";
import { SelectableResultRowProps } from "./types";

export function SelectableResultRow({
  rowData,
  selected,
  onCheckedChange,
}: SelectableResultRowProps) {
  const [isHovered, setIsHovered] = useState(false);

  const handleOnRowSelected = ({ checked }: { checked: boolean | string }) => {
    onCheckedChange(rowData, checked);
  };

  return (
    <TableRow
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <TableCell>
        <Checkbox
          name={`checkbox-${rowData.id}`}
          onCheckedChange={handleOnRowSelected}
          checked={selected}
        />
      </TableCell>
      <TableCell>
        <Heading size="lg">{rowData.publication_name}</Heading>
        {rowData.author}
      </TableCell>
      <TableCell>{rowData.summary}</TableCell>
      <TableCell>
        <div style={{ width: "fit-content" }}>
          <Tag label={rowData.relevance} variant="success" />
        </div>
      </TableCell>
      <TableCell>{rowData.how_relevant}</TableCell>
      <TableCell width={200}>
        <div
          style={{
            display: "flex",
            gap: "8px",
            opacity: isHovered ? 1 : 0,
            pointerEvents: isHovered ? "auto" : "none",
          }}
        >
          <Button variant="borderless" leftIcon={<PiDownloadSimpleBold />} />
          <Button variant="borderless" leftIcon={<FaThumbsUp />} />
          <Button variant="borderless" leftIcon={<FaThumbsDown />} />
        </div>
      </TableCell>
    </TableRow>
  );
}
