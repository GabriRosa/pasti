/** Keys stay stable when a product is found again by barcode. */
export function foodQuantityKey(id, food) {
  const barcode = food.barcode || food.label?.barcode;
  return barcode ? `barcode-${barcode}` : id;
}

export function usualFoodQuantity(id, food, quantities = {}, fallback = 100) {
  const saved = quantities[foodQuantityKey(id, food)];
  return saved?.unit === food.unit ? saved.grams : fallback;
}
