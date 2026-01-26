import { render, screen } from "@testing-library/react";
import HomePage from "@/app/page";
import ChakraProvider from "@/app/Providers/ChakraProvider";

describe("Home Page", () => {
  it("renders the Ask WRI heading", () => {
    render(
      <ChakraProvider>
        <HomePage />
      </ChakraProvider>
    );

    expect(
      screen.getByRole("heading", { name: /Ask WRI/i })
    ).toBeInTheDocument();
  });
});