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

export const SelectableResultRow = ({
  rowData,
  selected,
  onCheckedChange,
}: SelectableResultRowProps) => {
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
          onFocus={() => setIsHovered(true)}
          onBlur={() => setIsHovered(false)}
          style={{
            display: "flex",
            gap: "8px",
            opacity: isHovered ? 1 : 0.1,
            transition: "opacity 0.2s ease-in-out",
          }}
        >
          <Button
            variant="borderless"
            leftIcon={<PiDownloadSimpleBold />}
            aria-label="Download publication"
          />
          <Button
            variant="borderless"
            leftIcon={<FaThumbsUp />}
            aria-label="Mark as helpful"
          />
          <Button
            variant="borderless"
            leftIcon={<FaThumbsDown />}
            aria-label="Mark as not helpful"
          />
        </div>
      </TableCell>
    </TableRow>
  );
};
