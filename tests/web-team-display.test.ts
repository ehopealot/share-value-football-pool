import { describe, expect, it } from "vitest";
import { displayTeamName } from "../src/web/team-display";

describe("team display names", () => {
  it("uses concise school names for NCAA football teams", () => {
    expect(displayTeamName("ncaaf", "Texas Longhorns")).toBe("Texas");
    expect(displayTeamName("ncaaf", "Miami (OH) RedHawks")).toBe("Miami (OH)");
    expect(displayTeamName("ncaaf", "Notre Dame Fighting Irish")).toBe("Notre Dame");
    expect(displayTeamName("ncaaf", "UT Rio Grande Valley Vaqueros")).toBe("UT Rio Grande Valley");
    expect(displayTeamName("ncaaf", "Buffalo Bulls")).toBe("Buffalo");
    expect(displayTeamName("ncaaf", "Delaware Blue Hens")).toBe("Delaware");
    expect(displayTeamName("ncaaf", "Colorado Buffaloes")).toBe("Colorado");
    expect(displayTeamName("ncaaf", "West Georgia Wolves")).toBe("West Georgia");
    expect(displayTeamName("ncaaf", "Kennesaw State Owls")).toBe("Kennesaw State");
    expect(displayTeamName("ncaaf", "UMass Minutemen")).toBe("UMass");
    expect(displayTeamName("ncaaf", "Illinois Fighting Illini")).toBe("Illinois");
    expect(displayTeamName("ncaaf", "UAB Blazers")).toBe("UAB");
    expect(displayTeamName("ncaaf", "Minnesota Golden Gophers")).toBe("Minnesota");
    expect(displayTeamName("ncaaf", "Eastern Illinois Panthers")).toBe("Eastern Illinois");
  });

  it.each([
    ["Arizona Cardinals", "Arizona"],
    ["Atlanta Falcons", "Atlanta"],
    ["Baltimore Ravens", "Baltimore"],
    ["Buffalo Bills", "Buffalo"],
    ["Carolina Panthers", "Carolina"],
    ["Chicago Bears", "Chicago"],
    ["Cincinnati Bengals", "Cincinnati"],
    ["Cleveland Browns", "Cleveland"],
    ["Dallas Cowboys", "Dallas"],
    ["Denver Broncos", "Denver"],
    ["Detroit Lions", "Detroit"],
    ["Green Bay Packers", "Green Bay"],
    ["Houston Texans", "Houston"],
    ["Indianapolis Colts", "Indianapolis"],
    ["Jacksonville Jaguars", "Jacksonville"],
    ["Kansas City Chiefs", "Kansas City"],
    ["Las Vegas Raiders", "Las Vegas"],
    ["Los Angeles Chargers", "LAC"],
    ["Los Angeles Rams", "LAR"],
    ["Miami Dolphins", "Miami"],
    ["Minnesota Vikings", "Minnesota"],
    ["New England Patriots", "New England"],
    ["New Orleans Saints", "New Orleans"],
    ["New York Giants", "NYG"],
    ["New York Jets", "NYJ"],
    ["Philadelphia Eagles", "Philadelphia"],
    ["Pittsburgh Steelers", "Pittsburgh"],
    ["San Francisco 49ers", "San Francisco"],
    ["Seattle Seahawks", "Seattle"],
    ["Tampa Bay Buccaneers", "Tampa Bay"],
    ["Tennessee Titans", "Tennessee"],
    ["Washington Commanders", "Washington"]
  ])("displays NFL %s as %s", (name, location) => {
    expect(displayTeamName("nfl", name)).toBe(location);
  });

  it("keeps unknown names and non-team selections unchanged", () => {
    expect(displayTeamName("ncaaf", "Future State Narwhals")).toBe("Future State Narwhals");
    expect(displayTeamName("nfl", "Future City Narwhals")).toBe("Future City Narwhals");
    expect(displayTeamName("other", "Kansas City Chiefs")).toBe("Kansas City Chiefs");
    expect(displayTeamName("ncaaf", "Kansas City Chiefs")).toBe("Kansas City Chiefs");
    for (const name of ["Over", "Under", "O", "U", "NYJ", "NYG", "LAC", "LAR"]) {
      expect(displayTeamName("nfl", name)).toBe(name);
    }
  });
});
