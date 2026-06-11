// Represents a single meal or food entry
export interface FoodItem {
  id: string;
  name: string;
  calories: number;
}

// Represents a specific meal block
export interface Meal {
  type: "Breakfast" | "Lunch" | "Dinner" | "Snacks";
  foods: FoodItem[];
}

// Represents an entire day on the board
export interface DayRecord {
  date: string; // ISO format: "YYYY-MM-DD"
  meals: Meal[];
}

// Represents a single weight log entry
export interface WeightEntry {
  id: string;
  date: string; // Display format, e.g., "11/06/2026"
  weight: number; // KG
}
